/**
 * Device auth and pairing (I-125/I-126, design: docs/design/environments-and-store.md §3.5, §5).
 *
 * Who is "local": a request is the **local owner** when it reaches the server over loopback with a
 * loopback `Host`, carries no proxy headers (`Forwarded`, `X-Forwarded-*`, `Tailscale-User-*` —
 * `tailscale serve` adds these and a remote client can't remove them) and, if it has an `Origin`,
 * that origin is the server's own (its port or its web dev server's port). Everything else is a
 * **remote client** and needs a device token, and remote access must be enabled on the host.
 *
 * Remote clients:
 *   - HTTP: `Authorization: Bearer <deviceToken>`.
 *   - WebSocket: first `POST /api/auth/ws-ticket` (bearer) → `{ticket}`, then `GET /ws?ticket=…`
 *     (single use, 60 s). Long-lived tokens never go into URLs.
 *   - 401 `{code:"unauthorized"}` = no/invalid/revoked token (client shows "Pair again");
 *     403 `{code:"remote_disabled"}` = the host has remote access turned off.
 *
 * Endpoints (host side, local owner only unless noted):
 *   GET    /api/auth/remote                    → RemoteAccessState
 *   PATCH  /api/auth/remote {enabled}          → RemoteAccessState  (the host switch; off = refuse all remote;
 *                                                                    on also turns the master switch on)
 *   PATCH  /api/auth/remote {master}           → RemoteAccessState  (I-132 "Remote access" master switch: off also
 *                                                                    stops hosting, remembering the host switch;
 *                                                                    on restores it)
 *   POST   /api/auth/invites                   → PairingInvite      (replaces any active invite)
 *   DELETE /api/auth/invites/current           → 204
 *   GET    /api/auth/pending                   → PendingPairing[]   (also pushed as `pairing_pending`)
 *   POST   /api/auth/pending/:id {allow}       → 204                (host confirms or denies)
 *   GET    /api/auth/devices                   → PairedDevice[]
 *   PATCH  /api/auth/devices/:id {name}        → PairedDevice
 *   DELETE /api/auth/devices/:id               → 204  (revoke: token dead, its sockets closed at once)
 *   DELETE /api/auth/devices                   → 204  (revoke all)
 *   GET    /api/auth/audit?limit=              → AuditEntry[]
 *   GET    /api/auth/discover                  → DiscoveredEnvironment[] (Glade hosts on your tailnet, I-127)
 *   GET    /api/auth/peers                     → TailnetPeer[] (this Mac's tailnet peers, online or not, I-132)
 * Client side (no token yet, remote access must be on, rate-limited):
 *   POST   /api/auth/pair PairRequest          → PairResponse  (long-polls up to ~2 min for the host's answer)
 *   POST   /api/auth/pair TailnetPairRequest   → TailnetPairStart (I-143 code-free, answers at once)
 *   POST   /api/auth/pair/wait TailnetPairWait → PairResponse  (long-polls like the above; not rate-limited)
 * Any paired device (bearer):
 *   GET    /api/auth/me                        → PairedDevice (who am I; also refreshes last seen)
 *   POST   /api/auth/ws-ticket                 → { ticket: string; expiresAt: number }
 */

/** Host-side remote access state (Settings → Remote Access, "Let other devices use this device"). */
import { sha256Bytes } from "./sha256.js";

export interface RemoteAccessState {
  /** Remote clients are accepted at all (the host switch, and the master switch is on). Off by default. */
  enabled: boolean;
  /**
   * The "Remote access" master switch (I-132), stored on the local server so every window on
   * this Mac agrees. Off = no remote environments and no hosting. Absent on older servers.
   */
  master?: boolean;
  /** Addresses a client can reach this host at, best first (`https://<machine>.<tailnet>.ts.net` while Tailscale serves). */
  addresses: string[];
  /** How remote devices reach this host (I-127); absent on servers without a transport. */
  transport?: TransportStatus;
}

/** Why a transport can't be used right now (the UI shows fix-it text for each). */
export type TransportProblem =
  | "not_installed"
  | "cli_not_found"
  | "not_running"
  | "stopped"
  | "signed_out"
  | "https_off"
  | "funnel_on"
  | "port_in_use"
  | "error";

/**
 * A transport's state (I-127). Tailscale: Glade runs `tailscale serve --bg --https=443
 * http://127.0.0.1:<port>` (tailnet only, never Funnel) and HTTPS in the tailnet is required.
 */
export interface TransportStatus {
  id: "tailscale";
  /** Remote access can be turned on (installed, running, signed in, HTTPS on, port 443 free). */
  available: boolean;
  problem?: TransportProblem;
  /** Human text for `problem`, e.g. "HTTPS is off in your tailnet". */
  reason?: string;
  /** The tailnet has HTTPS certificates enabled for this machine. */
  https: boolean;
  /** Glade's serve handler is in place (tailnet → this Glade). */
  serving: boolean;
  /** `<machine>.<tailnet>.ts.net` (no trailing dot). */
  dnsName?: string;
  /** Tailscale IPs of this machine. */
  ips?: string[];
  /** This server turns serve on and off (the desktop app; dev servers only with GLADE_TAILSCALE_OWNER=1). */
  managed: boolean;
  /** The last serve change that failed, if any. */
  error?: string;
  /** The Tailscale account this machine is signed in to (`tailscale status --json`, I-143). */
  login?: string;
}

/** A Glade host found on the tailnet (`GET /api/auth/discover`). Pairing still needs its code. */
export interface DiscoveredEnvironment {
  /** The environment's name when it answered, else the machine's name. */
  name: string;
  /** `https://<machine>.<tailnet>.ts.net` */
  address: string;
  environmentId?: string;
  /** It answered `GET /api/environment` (Glade runs there with remote access on). */
  reachable: boolean;
  /** The peer's OS as Tailscale reports it ("macOS", "iOS"…). */
  os?: string;
}

/** A machine on this Mac's tailnet (`GET /api/auth/peers`, I-132): tells "offline" from "can't reach". */
export interface TailnetPeer {
  /** `<machine>.<tailnet>.ts.net`, lowercase, no trailing dot. */
  dnsName: string;
  name: string;
  /** Tailscale reports it online. */
  online: boolean;
  os?: string;
}

/**
 * A one-time invitation (5 minutes, one active at a time). The same secret is offered three ways:
 * a link (also rendered as a QR code), and a short code the user types together with the address.
 */
export interface PairingInvite {
  /** `glade://pair?…` link; contains env id + name, addresses and the grant (see `PairingLink`). */
  link: string;
  /** 8 characters, grouped `ABCD-EFGH` (Crockford base32, no ambiguous letters). */
  code: string;
  expiresAt: number;
}

/** What a pairing link carries (`glade://pair?v=1&e=…&n=…&u=…&u=…&g=…`). */
export interface PairingLink {
  version: 1;
  /** Host environment id; the client checks `GET /api/environment` returns the same id. */
  environmentId: string;
  /** Host name, for display before connecting. */
  name: string;
  /** Base URLs to try in order. */
  urls: string[];
  /** The one-time grant (the long secret; the short code is an alternative for typing). */
  grant: string;
}

export type DeviceKind = "mac" | "phone" | "browser" | "other";

export interface PairRequest {
  /** The link's grant, or the short code (either works; codes allow fewer attempts). */
  grant: string;
  /** Shown to the host in the confirm prompt and the devices list, e.g. "Jason's MacBook Air". */
  deviceName: string;
  deviceKind: DeviceKind;
  /** The client's own environment id, if it has one (a Mac app), for display. */
  clientEnvironmentId?: string;
}

/**
 * Code-free pairing on your own tailnet (I-143), numeric comparison as in Bluetooth:
 *
 * 1. The client sends `TailnetPairRequest` (a fresh random `clientNonce`) to the host's
 *    `https://<machine>.<tailnet>.ts.net` address.
 * 2. The host accepts it only when sharing is on, the request came through Tailscale Serve with a
 *    `Tailscale-User-Login` equal to the host's own Tailscale login, no other code-free request is
 *    waiting, it's not in the 60 s cooldown after a Deny and the address isn't rate-limited.
 *    Otherwise it answers `refused` (the client falls back to the code field).
 * 3. Accepted: the host answers `confirm` with its own random `hostNonce` and shows "<name> wants to
 *    use this device" with `pairingNumber(clientNonce, hostNonce)`; the client derives the same
 *    number itself and shows "Check that <host> shows 4729" while it long-polls
 *    `/api/auth/pair/wait` (the `clientNonce` proves it's the same client).
 * 4. Allow → `paired` (the same token as the code flow); Deny → `denied`; ~2 min → `timeout`.
 */
export interface TailnetPairRequest {
  mode: "tailnet";
  /** Random, 16–128 characters of base64url/hex (the client keeps it for the wait call). */
  clientNonce: string;
  deviceName: string;
  deviceKind: DeviceKind;
  clientEnvironmentId?: string;
}

/** Why a host won't take a code-free request (the client shows a one-line reason and the code field). */
export type TailnetPairRefusal =
  /** The request didn't come through Tailscale Serve with a user identity (e.g. a tagged device, the LAN). */
  | "no_identity"
  /** A different Tailscale account than the host's. */
  | "other_account"
  /** The host can't tell its own Tailscale account right now. */
  | "unavailable"
  /** Another code-free request is waiting for an answer. */
  | "busy"
  /** The host denied one less than a minute ago. */
  | "cooldown";

export type TailnetPairStart =
  | { status: "confirm"; requestId: string; hostNonce: string; expiresAt: number }
  | { status: "refused"; reason: TailnetPairRefusal };

export interface TailnetPairWait {
  requestId: string;
  clientNonce: string;
}

/** The 4-digit number both sides show (I-143): SHA-256(clientNonce + ":" + hostNonce) mod 10000, zero-padded. */
export function pairingNumber(clientNonce: string, hostNonce: string): string {
  const hash = sha256Bytes(`${clientNonce}:${hostNonce}`);
  // The first 6 bytes as a number (well within 2^53), mod 10000: bias ≈ 10000 / 2^48, nil.
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + hash[i]!;
  return String(n % 10000).padStart(4, "0");
}

export type PairResponse =
  | { status: "paired"; token: string; device: PairedDevice; environmentId: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "timeout" };

/** A pairing waiting for the host user's "Allow"/"Deny". */
export interface PendingPairing {
  id: string;
  deviceName: string;
  deviceKind: DeviceKind;
  /** Where the request came from (IP, and a Tailscale login when known — a hint only). */
  remoteAddress: string | null;
  tailscaleLogin: string | null;
  requestedAt: number;
  /** Code-free request (I-143): the 4-digit number the requesting device shows too. */
  number?: string;
}

export interface PairedDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  createdAt: number;
  lastSeenAt: number | null;
  lastAddress: string | null;
  tailscaleLogin: string | null;
  /** The device's own environment id, sent when it paired (I-136: matches it to an environment this device uses); null if it has none. */
  clientEnvironmentId?: string | null;
  /** v1 is always ["full"]; kept for read-only devices later. */
  scopes: string[];
  /** Live sockets right now. */
  connected: boolean;
}

export type AuditAction =
  | "invite_created"
  | "invite_cancelled"
  | "pair_requested"
  | "pair_allowed"
  | "pair_denied"
  | "pair_failed"
  | "device_revoked"
  | "device_renamed"
  | "auth_failed"
  | "remote_enabled"
  | "remote_disabled";

export interface AuditEntry {
  at: number;
  action: AuditAction;
  deviceId: string | null;
  deviceName: string | null;
  remoteAddress: string | null;
  detail: string | null;
}
