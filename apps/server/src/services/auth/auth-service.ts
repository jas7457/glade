/**
 * Device auth and pairing (I-125/I-126; contract: packages/protocol/src/auth.ts; design:
 * docs/design/environments-and-store.md §3.5).
 *
 * - **Remote switch:** `meta.remote_access` ("1" = on, off by default). Off refuses every remote
 *   request, closes remote sockets (4403) and drops pairings in flight.
 * - **Master switch (I-132):** `meta.remote_master` ("Remote access" at the top of Settings).
 *   Hosting needs it on too. Off turns hosting off (`remote_access` = "0", so older servers on
 *   the data folder comply) and remembers the host switch in `meta.remote_host`; on restores it
 *   (the route does, through the transport). Migration: master = on when hosting was on.
 * - **Devices:** 256-bit bearer tokens, stored as SHA-256 hashes, sliding expiry (unused for
 *   90 days = expired). Last seen/address are refreshed at most once a minute per device.
 *   Revoking closes the device's sockets at once (4401).
 * - **Invites:** one active at a time, 5 minutes, a 128-bit grant (the link / QR code) and an
 *   8-character code; both hashed. 5 wrong codes and the invite dies. A pairing request consumes
 *   the invite, waits for the host's Allow/Deny (up to ~2 minutes) and only then gets a token.
 * - **Pending pairings** live in the database so any server on the data folder can list and
 *   answer them; `pairing_pending` pushes go to this server's local-owner sockets.
 * - **WebSocket tickets** (single use, 60 s) are per server, in memory.
 * - **Multi-server:** a 1 s watch notices changes made by another server on the same data folder
 *   (a revoke, the switch, a new pending pairing) and applies them to this server's sockets.
 * - **Code-free pairing on your own tailnet (I-143):** `startTailnetPair` takes a request without a
 *   code only when hosting is on, it came through Tailscale Serve (the route passes the
 *   `Tailscale-User-Login` serve set, loopback peer only) with the host's own Tailscale login, no
 *   other code-free request is waiting (`invite_id` = 'tailnet'), it's not within 60 s of a Deny
 *   (`meta.tailnet_pair_cooldown_until`) and the address isn't rate-limited (the route). The
 *   host's nonce, the number and the client nonce's hash live in `meta.tailnet_pair` (no schema
 *   change: a schema-4 server on the data folder still reads the pending row). The client waits
 *   with `waitTailnetPair` (its nonce proves it's the same client); Allow gives the usual token.
 * - **Audit:** pairing, revocation, the switch and failures (`auth_audit`, newest 2000 kept).
 */
import type {
  AuditAction,
  AuditEntry,
  DeviceKind,
  PairedDevice,
  PairingInvite,
  PairRequest,
  PairResponse,
  PendingPairing,
  RemoteAccessState,
  ServerMessage,
  TailnetPairRefusal,
  TailnetPairRequest,
  TailnetPairStart,
  TailnetPairWait,
} from "@glade/protocol";
import { pairingNumber } from "@glade/protocol";
import { getMeta, setMeta, transaction, type Db } from "../../store/db/database.js";
import { ulid } from "../../store/db/ids.js";
import { newPairingCode, normalizePairingCode, randomSecret, safeEqual, sha256 } from "./secrets.js";

export const REMOTE_ACCESS_KEY = "remote_access";
/** The "Remote access" master switch (I-132). */
export const REMOTE_MASTER_KEY = "remote_master";
/** The host switch the user chose, remembered while the master switch is off (I-132). */
export const REMOTE_HOST_KEY = "remote_host";
export const TOKEN_IDLE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
export const INVITE_TTL_MS = 5 * 60 * 1000;
export const TICKET_TTL_MS = 60 * 1000;
export const PAIR_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
/** `/api/auth/pair` attempts per remote address per minute, and in total per minute. */
export const PAIR_RATE_PER_ADDRESS = 5;
export const PAIR_RATE_GLOBAL = 30;
const TOUCH_INTERVAL_MS = 60 * 1000;
const AUDIT_KEEP = 2000;
export const MAX_DEVICE_NAME = 100;
/** Code-free pairing (I-143): the pending row's `invite_id`, its details and the cooldown after a Deny. */
export const TAILNET_INVITE_ID = "tailnet";
export const TAILNET_PAIR_KEY = "tailnet_pair";
export const TAILNET_COOLDOWN_KEY = "tailnet_pair_cooldown_until";
export const TAILNET_COOLDOWN_MS = 60 * 1000;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const DEVICE_KINDS: readonly DeviceKind[] = ["mac", "phone", "browser", "other"];

/** WebSocket close codes for remote sockets the host cut off. */
export const CLOSE_REVOKED = 4401;
export const CLOSE_REMOTE_DISABLED = 4403;

export interface AuthServiceOptions {
  db: Db;
  environmentId: string;
  environmentName: () => string;
  /** Base URLs clients can reach this host at, best first (RemoteAccessState.addresses). */
  addresses: () => string[];
  /** More hostnames the Host allow-list accepts (the transport's DNS name, I-127). */
  hostnames?: () => string[];
  now?: () => number;
  /** Cross-server watch interval (ms); 0 = off (tests call `watch()`). Default 1000. */
  watchMs?: number;
  /** How long `/api/auth/pair` waits for the host's answer. */
  pairTimeoutMs?: number;
  /** How often a waiting pairing checks for the answer (ms). */
  pairPollMs?: number;
  /** The Tailscale account this machine is signed in to, read fresh (I-143); null when unknown. */
  tailscaleLogin?: () => Promise<string | null>;
}

/** Who a request or socket is (set by the security middleware). */
export type Identity =
  | { kind: "local" }
  | { kind: "remote"; device: DeviceRow | null; address: string | null; tailscaleLogin: string | null };

/** A live socket, as the auth service sees it. */
export interface AuthSocket {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface DeviceRow {
  id: string;
  name: string;
  kind: DeviceKind;
  token_hash: string;
  scopes_json: string;
  created_at: number;
  last_seen_at: number | null;
  last_address: string | null;
  tailscale_login: string | null;
  client_environment_id: string | null;
  revoked_at: number | null;
}

interface InviteRow {
  id: string;
  grant_hash: string;
  code_hash: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  attempts: number;
}

interface PendingRow {
  id: string;
  invite_id: string;
  device_name: string;
  device_kind: DeviceKind;
  client_environment_id: string | null;
  remote_address: string | null;
  tailscale_login: string | null;
  requested_at: number;
  expires_at: number;
  status: "pending" | "allowed" | "denied" | "expired" | "cancelled" | "paired";
  device_id: string | null;
}

/** An error the routes turn into `{ code, error }` with this status. */
export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RequestMeta {
  address: string | null;
  tailscaleLogin: string | null;
}

/** `meta.tailnet_pair`: the code-free request in flight (I-143). */
interface TailnetPairMeta {
  id: string;
  number: string;
  clientNonceHash: string;
}

export class AuthService {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly pairTimeoutMs: number;
  private readonly pairPollMs: number;
  private readonly tickets = new Map<string, { deviceId: string; expiresAt: number }>();
  private readonly localSockets = new Set<AuthSocket>();
  private readonly remoteSockets = new Map<string, Set<AuthSocket>>();
  private readonly lastTouch = new Map<string, number>();
  private readonly pairHits = new Map<string, number[]>();
  private globalPairHits: number[] = [];
  private readonly failedAudit = new Map<string, number>();
  private lastPendingKey = "[]";
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: AuthServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? Date.now;
    this.pairTimeoutMs = options.pairTimeoutMs ?? PAIR_TIMEOUT_MS;
    this.pairPollMs = options.pairPollMs ?? 250;
    this.migrateMaster();
    const watchMs = options.watchMs ?? 1000;
    if (watchMs > 0) {
      this.timer = setInterval(() => this.watch(), watchMs);
      this.timer.unref();
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Remote switch ------------------------------------------------------------------------------

  /** I-132: data folders from before the master switch get master = on when hosting was on. */
  private migrateMaster(): void {
    if (getMeta(this.db, REMOTE_MASTER_KEY) !== null) return;
    const hosting = getMeta(this.db, REMOTE_ACCESS_KEY) === "1";
    transaction(this.db, () => {
      if (getMeta(this.db, REMOTE_MASTER_KEY) !== null) return;
      setMeta(this.db, REMOTE_MASTER_KEY, hosting ? "1" : "0");
      if (getMeta(this.db, REMOTE_HOST_KEY) === null) setMeta(this.db, REMOTE_HOST_KEY, hosting ? "1" : "0");
    });
  }

  /** Hosting is on: the host switch and the master switch. */
  isRemoteEnabled(): boolean {
    return getMeta(this.db, REMOTE_ACCESS_KEY) === "1" && this.isMasterOn();
  }

  /** The "Remote access" master switch (I-132). */
  isMasterOn(): boolean {
    return getMeta(this.db, REMOTE_MASTER_KEY) === "1";
  }

  /** The host switch as the user last set it (restored when the master switch goes back on). */
  hostPreference(): boolean {
    return getMeta(this.db, REMOTE_HOST_KEY) === "1";
  }

  remoteState(): RemoteAccessState {
    return { enabled: this.isRemoteEnabled(), master: this.isMasterOn(), addresses: this.options.addresses() };
  }

  /** Hostnames a `Host` header may name besides loopback (from the addresses). */
  allowedHostnames(): Set<string> {
    const out = new Set<string>();
    for (const address of this.options.addresses()) {
      try {
        out.add(new URL(address).hostname.toLowerCase());
      } catch {
        /* not a URL */
      }
    }
    for (const name of this.options.hostnames?.() ?? []) out.add(name.toLowerCase());
    return out;
  }

  /** The host switch. Turning it on turns the master switch on too. */
  setRemoteEnabled(enabled: boolean, meta: RequestMeta = { address: null, tailscaleLogin: null }): RemoteAccessState {
    const was = this.isRemoteEnabled();
    setMeta(this.db, REMOTE_HOST_KEY, enabled ? "1" : "0");
    if (enabled && !this.isMasterOn()) setMeta(this.db, REMOTE_MASTER_KEY, "1");
    this.applyHosting(was, enabled, meta);
    return this.remoteState();
  }

  /**
   * The master switch (I-132). Off stops hosting at once (sockets closed with 4403) and keeps
   * the host switch's value in `remote_host`. On only flips the flag: the caller restores
   * hosting (`hostPreference()`) through the transport, which may refuse.
   */
  setMaster(on: boolean, meta: RequestMeta = { address: null, tailscaleLogin: null }): RemoteAccessState {
    const was = this.isRemoteEnabled();
    setMeta(this.db, REMOTE_MASTER_KEY, on ? "1" : "0");
    if (!on) this.applyHosting(was, false, meta);
    return this.remoteState();
  }

  private applyHosting(was: boolean, enabled: boolean, meta: RequestMeta): void {
    if (was !== enabled || getMeta(this.db, REMOTE_ACCESS_KEY) !== (enabled ? "1" : "0")) {
      transaction(this.db, () => {
        setMeta(this.db, REMOTE_ACCESS_KEY, enabled ? "1" : "0");
        if (was === enabled) return;
        if (!enabled) {
          // Nothing remote survives: pairings in flight fail, invites die.
          this.db.prepare("UPDATE pairing_pending SET status = 'expired' WHERE status IN ('pending', 'allowed')").run();
          this.db.prepare("UPDATE pairing_invites SET used_at = ? WHERE used_at IS NULL").run(this.now());
        }
        this.audit(enabled ? "remote_enabled" : "remote_disabled", { remoteAddress: meta.address });
      });
      if (was !== enabled) {
        if (!enabled) this.cutOffRemote();
        this.pushPending();
      }
    }
  }

  // Invites ------------------------------------------------------------------------------------

  /** A new invite (the previous one, if any, dies). Remote access must be on. */
  createInvite(): PairingInvite {
    if (!this.isRemoteEnabled()) throw new AuthError(409, "remote_disabled", "Turn on remote access first.");
    const grant = randomSecret(16);
    const code = newPairingCode();
    const now = this.now();
    const expiresAt = now + INVITE_TTL_MS;
    transaction(this.db, () => {
      this.db.prepare("UPDATE pairing_invites SET used_at = ? WHERE used_at IS NULL").run(now);
      this.db
        .prepare("INSERT INTO pairing_invites (id, grant_hash, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
        .run(ulid(), sha256(grant), sha256(normalizePairingCode(code)!), now, expiresAt);
      this.audit("invite_created", {});
    });
    return { link: this.pairingLink(grant), code, expiresAt };
  }

  cancelInvite(): void {
    const changes = Number(this.db.prepare("UPDATE pairing_invites SET used_at = ? WHERE used_at IS NULL AND expires_at > ?").run(this.now(), this.now()).changes);
    if (changes > 0) this.audit("invite_cancelled", {});
  }

  /** `glade://pair?v=1&e=<envId>&n=<name>&u=<url>…&g=<grant>` (PairingLink). */
  pairingLink(grant: string): string {
    const params = new URLSearchParams();
    params.set("v", "1");
    params.set("e", this.options.environmentId);
    params.set("n", this.options.environmentName());
    for (const url of this.options.addresses()) params.append("u", url);
    params.set("g", grant);
    return `glade://pair?${params.toString()}`;
  }

  // Pairing ------------------------------------------------------------------------------------

  /** Rate limit for `/api/auth/pair`: throws 429 when over. */
  checkPairRate(address: string | null): void {
    const now = this.now();
    const recent = (hits: number[]) => hits.filter((t) => now - t < 60_000);
    const key = address ?? "unknown";
    const mine = recent(this.pairHits.get(key) ?? []);
    this.globalPairHits = recent(this.globalPairHits);
    if (mine.length >= PAIR_RATE_PER_ADDRESS || this.globalPairHits.length >= PAIR_RATE_GLOBAL) {
      this.audit("pair_failed", { remoteAddress: address, detail: "rate limited" });
      throw new AuthError(429, "rate_limited", "Too many pairing attempts. Wait a minute and try again.");
    }
    mine.push(now);
    this.pairHits.set(key, mine);
    this.globalPairHits.push(now);
    if (this.pairHits.size > 1000) this.pairHits.clear();
  }

  /**
   * A client asks to pair: validates the grant or code, consumes the invite, creates a pending
   * pairing and waits for the host's answer (or the timeout, or `signal`).
   */
  async pair(req: Partial<PairRequest>, meta: RequestMeta, signal?: AbortSignal): Promise<PairResponse> {
    if (typeof req.grant !== "string" || !req.grant.trim()) throw new AuthError(400, "invalid_request", "grant is required");
    const deviceName = typeof req.deviceName === "string" ? req.deviceName.trim().slice(0, MAX_DEVICE_NAME) : "";
    if (!deviceName) throw new AuthError(400, "invalid_request", "deviceName is required");
    const deviceKind: DeviceKind = req.deviceKind && DEVICE_KINDS.includes(req.deviceKind) ? req.deviceKind : "other";
    const clientEnvironmentId = typeof req.clientEnvironmentId === "string" ? req.clientEnvironmentId.slice(0, 64) : null;

    const now = this.now();
    const grant = req.grant.trim();
    const code = normalizePairingCode(grant);
    const pendingId = ulid();
    const outcome = transaction(this.db, (): "invalid" | "expired" | "ok" => {
      const match = (
        code
          ? this.db.prepare("SELECT * FROM pairing_invites WHERE code_hash = ? ORDER BY created_at DESC LIMIT 1").get(sha256(code))
          : this.db.prepare("SELECT * FROM pairing_invites WHERE grant_hash = ?").get(sha256(grant))
      ) as InviteRow | undefined;
      if (!match) {
        if (code) {
          // A wrong code counts against the active invite; too many and it dies.
          const active = this.activeInvite(now);
          if (active) {
            const attempts = active.attempts + 1;
            this.db
              .prepare("UPDATE pairing_invites SET attempts = ?, used_at = CASE WHEN ? >= ? THEN ? ELSE used_at END WHERE id = ?")
              .run(attempts, attempts, MAX_CODE_ATTEMPTS, now, active.id);
            if (attempts >= MAX_CODE_ATTEMPTS) this.audit("pair_failed", { deviceName, remoteAddress: meta.address, detail: "too many wrong codes: invite cancelled" });
          }
        }
        this.audit("pair_failed", { deviceName, remoteAddress: meta.address, detail: code ? "wrong code" : "unknown grant" });
        return "invalid";
      }
      if (match.used_at !== null || match.expires_at <= now) {
        this.audit("pair_failed", { deviceName, remoteAddress: meta.address, detail: "invite expired or used" });
        return "expired";
      }
      this.db.prepare("UPDATE pairing_invites SET used_at = ? WHERE id = ?").run(now, match.id);
      this.db
        .prepare(
          `INSERT INTO pairing_pending (id, invite_id, device_name, device_kind, client_environment_id, remote_address, tailscale_login, requested_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(pendingId, match.id, deviceName, deviceKind, clientEnvironmentId, meta.address, meta.tailscaleLogin, now, now + this.pairTimeoutMs);
      this.audit("pair_requested", { deviceName, remoteAddress: meta.address, detail: meta.tailscaleLogin ? `tailscale: ${meta.tailscaleLogin}` : null });
      return "ok";
    });
    if (outcome === "invalid") throw new AuthError(400, "invalid_grant", "That code or link isn't valid. Check it, or create a new invite on the host.");
    if (outcome === "expired") return { status: "expired" };
    this.pushPending();
    return this.awaitAnswer(pendingId, deviceName, meta, signal);
  }

  /** Wait for the host's answer to a pending pairing (or its timeout, or `signal`). */
  private async awaitAnswer(pendingId: string, deviceName: string, meta: RequestMeta, signal?: AbortSignal): Promise<PairResponse> {
    try {
      for (;;) {
        const row = this.db.prepare("SELECT * FROM pairing_pending WHERE id = ?").get(pendingId) as PendingRow | undefined;
        if (!row || row.status === "expired" || row.status === "cancelled") return { status: "expired" };
        if (row.status === "denied") return { status: "denied" };
        if (row.status === "allowed") return this.completePairing(row);
        if (this.now() >= row.expires_at) {
          this.setPendingStatus(pendingId, "expired", "pending");
          this.audit("pair_failed", { deviceName, remoteAddress: meta.address, detail: "no answer in time" });
          return { status: "timeout" };
        }
        if (signal?.aborted) {
          if (this.setPendingStatus(pendingId, "cancelled", "pending")) this.audit("pair_failed", { deviceName, remoteAddress: meta.address, detail: "cancelled by the device" });
          return { status: "expired" };
        }
        await sleep(this.pairPollMs, signal);
      }
    } finally {
      this.pushPending();
    }
  }

  // Code-free pairing on your own tailnet (I-143) ---------------------------------------------

  /**
   * A code-free request. `servedLogin` is the `Tailscale-User-Login` Tailscale Serve set (the
   * route passes null unless the request came through serve). Refusals are answers, not errors,
   * so the client can fall back to the code field with a reason; all of them are audited.
   */
  async startTailnetPair(req: Partial<TailnetPairRequest>, meta: RequestMeta, servedLogin: string | null): Promise<TailnetPairStart> {
    const clientNonce = typeof req.clientNonce === "string" ? req.clientNonce : "";
    if (!NONCE_RE.test(clientNonce)) throw new AuthError(400, "invalid_request", "clientNonce must be 16-128 characters of [A-Za-z0-9_-]");
    const deviceName = typeof req.deviceName === "string" ? req.deviceName.trim().slice(0, MAX_DEVICE_NAME) : "";
    if (!deviceName) throw new AuthError(400, "invalid_request", "deviceName is required");
    const deviceKind: DeviceKind = req.deviceKind && DEVICE_KINDS.includes(req.deviceKind) ? req.deviceKind : "other";
    const clientEnvironmentId = typeof req.clientEnvironmentId === "string" ? req.clientEnvironmentId.slice(0, 64) : null;

    const refuse = (reason: TailnetPairRefusal, detail: string): TailnetPairStart => {
      this.audit("pair_failed", { deviceName, remoteAddress: meta.address, detail: `code-free refused: ${detail}` });
      return { status: "refused", reason };
    };
    if (!this.isRemoteEnabled()) return refuse("unavailable", "sharing is off");
    if (!servedLogin) return refuse("no_identity", "no Tailscale identity (not through Tailscale Serve, or a tagged device)");
    const hostLogin = (await this.options.tailscaleLogin?.().catch(() => null)) ?? null;
    if (!hostLogin) return refuse("unavailable", "this host's Tailscale account is unknown");
    if (servedLogin.toLowerCase() !== hostLogin.toLowerCase()) return refuse("other_account", `other Tailscale account (${servedLogin})`);

    const now = this.now();
    const id = ulid();
    const hostNonce = randomSecret(16);
    const number = pairingNumber(clientNonce, hostNonce);
    const expiresAt = now + this.pairTimeoutMs;
    const outcome = transaction(this.db, (): TailnetPairRefusal | "ok" => {
      if (!this.isRemoteEnabled()) return "unavailable";
      if (Number(getMeta(this.db, TAILNET_COOLDOWN_KEY) ?? 0) > now) return "cooldown";
      const waiting = this.db
        .prepare("SELECT 1 FROM pairing_pending WHERE invite_id = ? AND status IN ('pending', 'allowed') AND expires_at > ? LIMIT 1")
        .get(TAILNET_INVITE_ID, now);
      if (waiting) return "busy";
      const details: TailnetPairMeta = { id, number, clientNonceHash: sha256(clientNonce) };
      setMeta(this.db, TAILNET_PAIR_KEY, JSON.stringify(details));
      this.db
        .prepare(
          `INSERT INTO pairing_pending (id, invite_id, device_name, device_kind, client_environment_id, remote_address, tailscale_login, requested_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, TAILNET_INVITE_ID, deviceName, deviceKind, clientEnvironmentId, meta.address, servedLogin, now, expiresAt);
      this.audit("pair_requested", { deviceName, remoteAddress: meta.address, detail: `code-free, tailscale: ${servedLogin}, number ${number}` });
      return "ok";
    });
    if (outcome !== "ok") {
      const why: Record<TailnetPairRefusal, string> = {
        cooldown: "denied less than a minute ago",
        busy: "another code-free request is waiting",
        unavailable: "sharing is off",
        no_identity: "no Tailscale identity",
        other_account: "other Tailscale account",
      };
      return refuse(outcome, why[outcome]);
    }
    this.pushPending();
    return { status: "confirm", requestId: id, hostNonce, expiresAt };
  }

  /** The code-free client waits for Allow/Deny: same client (nonce) and same Tailscale login as the request. */
  async waitTailnetPair(req: Partial<TailnetPairWait>, meta: RequestMeta, servedLogin: string | null, signal?: AbortSignal): Promise<PairResponse> {
    const requestId = typeof req.requestId === "string" ? req.requestId : "";
    const clientNonce = typeof req.clientNonce === "string" ? req.clientNonce : "";
    if (!requestId || !NONCE_RE.test(clientNonce)) throw new AuthError(400, "invalid_request", "requestId and clientNonce are required");
    const details = this.tailnetPairMeta();
    const row = this.db.prepare("SELECT * FROM pairing_pending WHERE id = ? AND invite_id = ?").get(requestId, TAILNET_INVITE_ID) as PendingRow | undefined;
    const sameClient = !!row && details?.id === requestId && safeEqual(sha256(clientNonce), details.clientNonceHash);
    const sameLogin = !!row && !!servedLogin && servedLogin.toLowerCase() === (row.tailscale_login ?? "").toLowerCase();
    if (!row || !sameClient || !sameLogin) {
      this.audit("pair_failed", { deviceName: row?.device_name ?? null, remoteAddress: meta.address, detail: !row ? "code-free wait: unknown request" : !sameClient ? "code-free wait: wrong client" : "code-free wait: other Tailscale identity" });
      throw new AuthError(404, "not_found", "That request is no longer waiting.");
    }
    return this.awaitAnswer(row.id, row.device_name, meta, signal);
  }

  private tailnetPairMeta(): TailnetPairMeta | null {
    try {
      const v = JSON.parse(getMeta(this.db, TAILNET_PAIR_KEY) ?? "null") as TailnetPairMeta | null;
      return v && typeof v.id === "string" && typeof v.number === "string" && typeof v.clientNonceHash === "string" ? v : null;
    } catch {
      return null;
    }
  }

  /** The host answers a pending pairing; false when it's not (or no longer) waiting. */
  answerPending(id: string, allow: boolean): boolean {
    const row = this.db.prepare("SELECT * FROM pairing_pending WHERE id = ?").get(id) as PendingRow | undefined;
    if (!row || row.status !== "pending" || row.expires_at <= this.now()) return false;
    if (!this.setPendingStatus(id, allow ? "allowed" : "denied", "pending")) return false;
    const codeFree = row.invite_id === TAILNET_INVITE_ID;
    if (codeFree && !allow) setMeta(this.db, TAILNET_COOLDOWN_KEY, String(this.now() + TAILNET_COOLDOWN_MS));
    this.audit(allow ? "pair_allowed" : "pair_denied", { deviceName: row.device_name, remoteAddress: row.remote_address, detail: codeFree ? "code-free" : null });
    this.pushPending();
    return true;
  }

  listPending(): PendingPairing[] {
    const rows = this.db
      .prepare("SELECT * FROM pairing_pending WHERE status = 'pending' AND expires_at > ? ORDER BY requested_at")
      .all(this.now()) as unknown as PendingRow[];
    const tailnet = rows.some((r) => r.invite_id === TAILNET_INVITE_ID) ? this.tailnetPairMeta() : null;
    return rows.map((r) => ({
      ...(r.invite_id === TAILNET_INVITE_ID && tailnet?.id === r.id ? { number: tailnet.number } : {}),
      id: r.id,
      deviceName: r.device_name,
      deviceKind: r.device_kind,
      remoteAddress: r.remote_address,
      tailscaleLogin: r.tailscale_login,
      requestedAt: r.requested_at,
    }));
  }

  private completePairing(row: PendingRow): PairResponse {
    const token = randomSecret(32);
    const id = ulid();
    const now = this.now();
    const ok = transaction(this.db, () => {
      if (!this.setPendingStatus(row.id, "paired", "allowed")) return false;
      this.db
        .prepare(
          `INSERT INTO devices (id, name, kind, token_hash, created_at, last_seen_at, last_address, tailscale_login, client_environment_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, row.device_name, row.device_kind, sha256(token), now, now, row.remote_address, row.tailscale_login, row.client_environment_id);
      this.db.prepare("UPDATE pairing_pending SET device_id = ? WHERE id = ?").run(id, row.id);
      return true;
    });
    if (!ok) return { status: "expired" };
    return { status: "paired", token, device: this.toPaired(this.deviceById(id)!), environmentId: this.options.environmentId };
  }

  private setPendingStatus(id: string, status: PendingRow["status"], from: PendingRow["status"]): boolean {
    return Number(this.db.prepare("UPDATE pairing_pending SET status = ? WHERE id = ? AND status = ?").run(status, id, from).changes) > 0;
  }

  private activeInvite(now: number): InviteRow | null {
    return (
      (this.db.prepare("SELECT * FROM pairing_invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").get(now) as InviteRow | undefined) ?? null
    );
  }

  // Devices ------------------------------------------------------------------------------------

  /** The device a bearer token belongs to (refreshing its last seen), or null (audited). */
  authenticate(token: string | null, meta: RequestMeta): DeviceRow | null {
    const device = token ? (this.db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(sha256(token)) as DeviceRow | undefined) : undefined;
    if (!device || !this.isUsable(device)) {
      this.auditFailure(meta, !token ? "no token" : !device ? "unknown token" : device.revoked_at !== null ? "revoked device" : "expired token", device);
      return null;
    }
    this.touch(device, meta);
    return device;
  }

  private isUsable(device: DeviceRow): boolean {
    return device.revoked_at === null && (device.last_seen_at ?? device.created_at) > this.now() - TOKEN_IDLE_EXPIRY_MS;
  }

  private touch(device: DeviceRow, meta: RequestMeta): void {
    const now = this.now();
    const last = this.lastTouch.get(device.id) ?? 0;
    if (now - last < TOUCH_INTERVAL_MS && device.last_address === meta.address) return;
    this.lastTouch.set(device.id, now);
    this.db
      .prepare("UPDATE devices SET last_seen_at = ?, last_address = ?, tailscale_login = COALESCE(?, tailscale_login) WHERE id = ?")
      .run(now, meta.address, meta.tailscaleLogin, device.id);
  }

  /** `GET /api/auth/me`: always refreshes last seen. */
  me(device: DeviceRow, meta: RequestMeta): PairedDevice {
    this.lastTouch.delete(device.id);
    this.touch(device, meta);
    return this.toPaired(this.deviceById(device.id)!);
  }

  listDevices(): PairedDevice[] {
    const rows = this.db.prepare("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at").all() as unknown as DeviceRow[];
    return rows.map((r) => this.toPaired(r));
  }

  renameDevice(id: string, name: unknown): PairedDevice {
    if (typeof name !== "string" || !name.trim()) throw new AuthError(400, "invalid_request", "name is required");
    if (name.trim().length > MAX_DEVICE_NAME) throw new AuthError(400, "invalid_request", `name can be at most ${MAX_DEVICE_NAME} characters`);
    const device = this.deviceById(id);
    if (!device || device.revoked_at !== null) throw new AuthError(404, "not_found", "No such device");
    this.db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name.trim(), id);
    this.audit("device_renamed", { deviceId: id, deviceName: name.trim(), detail: `was "${device.name}"` });
    return this.toPaired(this.deviceById(id)!);
  }

  /** Revoke one device: its token stops working and its sockets close now. False if unknown. */
  revokeDevice(id: string): boolean {
    const device = this.deviceById(id);
    if (!device || device.revoked_at !== null) return false;
    this.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(this.now(), id);
    this.audit("device_revoked", { deviceId: id, deviceName: device.name });
    this.dropDevice(id);
    return true;
  }

  revokeAll(): void {
    for (const device of this.listDevices()) this.revokeDevice(device.id);
  }

  private deviceById(id: string): DeviceRow | null {
    return (this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined) ?? null;
  }

  private toPaired(r: DeviceRow): PairedDevice {
    let scopes: string[] = ["full"];
    try {
      const parsed = JSON.parse(r.scopes_json) as unknown;
      if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === "string");
    } catch {
      /* keep full */
    }
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      lastAddress: r.last_address,
      tailscaleLogin: r.tailscale_login,
      clientEnvironmentId: r.client_environment_id,
      scopes,
      connected: (this.remoteSockets.get(r.id)?.size ?? 0) > 0,
    };
  }

  // WebSocket tickets and sockets --------------------------------------------------------------

  issueTicket(device: DeviceRow): { ticket: string; expiresAt: number } {
    const now = this.now();
    for (const [t, v] of this.tickets) if (v.expiresAt <= now) this.tickets.delete(t);
    const ticket = randomSecret(32);
    const expiresAt = now + TICKET_TTL_MS;
    this.tickets.set(ticket, { deviceId: device.id, expiresAt });
    return { ticket, expiresAt };
  }

  /** Redeem a ticket (single use): its device if still valid, else null (audited). */
  redeemTicket(ticket: string | null, meta: RequestMeta): DeviceRow | null {
    const entry = ticket ? this.tickets.get(ticket) : undefined;
    if (ticket) this.tickets.delete(ticket);
    const device = entry && entry.expiresAt > this.now() ? this.deviceById(entry.deviceId) : null;
    if (!device || !this.isUsable(device)) {
      this.auditFailure(meta, !ticket ? "no socket ticket" : "invalid socket ticket", device ?? undefined);
      return null;
    }
    this.touch(device, meta);
    return device;
  }

  /** Track a socket (remote ones by device, for revocation; local ones get pairing pushes). */
  attachSocket(identity: Identity, socket: AuthSocket): () => void {
    if (identity.kind === "local") {
      this.localSockets.add(socket);
      const pending = this.listPending();
      if (pending.length) socket.send({ type: "pairing_pending", pending });
      return () => this.localSockets.delete(socket);
    }
    const id = identity.device?.id;
    if (!id) return () => {};
    let set = this.remoteSockets.get(id);
    if (!set) this.remoteSockets.set(id, (set = new Set()));
    set.add(socket);
    return () => {
      const s = this.remoteSockets.get(id);
      s?.delete(socket);
      if (s && s.size === 0) this.remoteSockets.delete(id);
    };
  }

  private dropDevice(id: string): void {
    for (const [t, v] of this.tickets) if (v.deviceId === id) this.tickets.delete(t);
    const sockets = this.remoteSockets.get(id);
    this.remoteSockets.delete(id);
    for (const s of sockets ?? []) s.close(CLOSE_REVOKED, "device revoked");
  }

  private cutOffRemote(): void {
    this.tickets.clear();
    const all = [...this.remoteSockets.values()];
    this.remoteSockets.clear();
    for (const set of all) for (const s of set) s.close(CLOSE_REMOTE_DISABLED, "remote access turned off");
  }

  private pushPending(): void {
    const pending = this.listPending();
    const key = JSON.stringify(pending);
    if (key === this.lastPendingKey) return;
    this.lastPendingKey = key;
    for (const s of this.localSockets) s.send({ type: "pairing_pending", pending });
  }

  /**
   * Apply changes other servers on the data folder made (and expiries): close sockets of
   * revoked devices or all remote ones when the switch went off; push the pending list if it
   * changed.
   */
  watch(): void {
    if (this.remoteSockets.size) {
      if (!this.isRemoteEnabled()) this.cutOffRemote();
      else
        for (const id of [...this.remoteSockets.keys()]) {
          const device = this.deviceById(id);
          if (!device || device.revoked_at !== null) this.dropDevice(id);
        }
    }
    if (this.localSockets.size) this.pushPending();
  }

  // Audit --------------------------------------------------------------------------------------

  listAudit(limit = 100): AuditEntry[] {
    const n = Math.max(1, Math.min(1000, Math.floor(limit) || 100));
    const rows = this.db.prepare("SELECT * FROM auth_audit ORDER BY id DESC LIMIT ?").all(n) as unknown as {
      at: number;
      action: AuditAction;
      device_id: string | null;
      device_name: string | null;
      remote_address: string | null;
      detail: string | null;
    }[];
    return rows.map((r) => ({ at: r.at, action: r.action, deviceId: r.device_id, deviceName: r.device_name, remoteAddress: r.remote_address, detail: r.detail }));
  }

  private audit(action: AuditAction, e: { deviceId?: string | null; deviceName?: string | null; remoteAddress?: string | null; detail?: string | null }): void {
    const res = this.db
      .prepare("INSERT INTO auth_audit (at, action, device_id, device_name, remote_address, detail) VALUES (?, ?, ?, ?, ?, ?)")
      .run(this.now(), action, e.deviceId ?? null, e.deviceName ?? null, e.remoteAddress ?? null, e.detail ?? null);
    const id = Number(res.lastInsertRowid);
    if (id % 100 === 0) this.db.prepare("DELETE FROM auth_audit WHERE id <= ?").run(id - AUDIT_KEEP);
  }

  /** Failed auth, audited at most once a minute per address (a stale client retries a lot). */
  private auditFailure(meta: RequestMeta, detail: string, device?: DeviceRow): void {
    const key = meta.address ?? "unknown";
    const now = this.now();
    if (now - (this.failedAudit.get(key) ?? -Infinity) < 60_000) return;
    this.failedAudit.set(key, now);
    if (this.failedAudit.size > 1000) this.failedAudit.clear();
    this.audit("auth_failed", { deviceId: device?.id ?? null, deviceName: device?.name ?? null, remoteAddress: meta.address, detail });
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
