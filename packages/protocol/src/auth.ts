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
 *   PATCH  /api/auth/remote {enabled}          → RemoteAccessState  (the host switch; off = refuse all remote)
 *   POST   /api/auth/invites                   → PairingInvite      (replaces any active invite)
 *   DELETE /api/auth/invites/current           → 204
 *   GET    /api/auth/pending                   → PendingPairing[]   (also pushed as `pairing_pending`)
 *   POST   /api/auth/pending/:id {allow}       → 204                (host confirms or denies)
 *   GET    /api/auth/devices                   → PairedDevice[]
 *   PATCH  /api/auth/devices/:id {name}        → PairedDevice
 *   DELETE /api/auth/devices/:id               → 204  (revoke: token dead, its sockets closed at once)
 *   DELETE /api/auth/devices                   → 204  (revoke all)
 *   GET    /api/auth/audit?limit=              → AuditEntry[]
 * Client side (no token yet, remote access must be on, rate-limited):
 *   POST   /api/auth/pair PairRequest          → PairResponse  (long-polls up to ~2 min for the host's answer)
 * Any paired device (bearer):
 *   GET    /api/auth/me                        → PairedDevice (who am I; also refreshes last seen)
 *   POST   /api/auth/ws-ticket                 → { ticket: string; expiresAt: number }
 */

/** Host-side remote access state (Settings → Remote Access, "Allow other devices"). */
export interface RemoteAccessState {
  /** Remote clients are accepted at all. Off by default. */
  enabled: boolean;
  /** Addresses a client can reach this host at, best first (phase 5 adds Tailscale ones). */
  addresses: string[];
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
}

export interface PairedDevice {
  id: string;
  name: string;
  kind: DeviceKind;
  createdAt: number;
  lastSeenAt: number | null;
  lastAddress: string | null;
  tailscaleLogin: string | null;
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
