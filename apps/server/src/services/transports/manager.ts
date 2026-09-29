/**
 * Remote access over a transport (I-127): connects the host switch (`meta.remote_access`,
 * services/auth) to a {@link Transport} (Tailscale today).
 *
 * **Which server manages the transport.** Several Glade servers can share one data folder (the
 * installed app, kind "desktop", next to `pnpm dev`). Only one should run `tailscale serve`, or
 * they'd fight over the handler. By default only the desktop app manages it
 * (`GLADE_SERVER_KIND=desktop`); other servers (dev, sandboxes) only read the status, unless
 * `GLADE_TAILSCALE_OWNER=1` (and `GLADE_TAILSCALE_OWNER=0` turns it off for the app). The switch
 * works from any server: it's shared in the database, and the managing server notices a change
 * within ~2 s and reconciles.
 *
 * - **Addresses:** `https://<machine>.<tailnet>.ts.net` while Glade's handler is in place.
 * - **Host allow-list:** the machine's DNS name once known (requests through serve keep it).
 * - **Turning on** refuses (409 `transport_unavailable`) while the transport isn't usable; the
 *   managing server turns serve on first and only then flips the switch. Turning off flips the
 *   switch first (remote clients are cut off at once) and then removes Glade's handler.
 * - **Reconcile** at startup, when the switch changes, and every 30 s while it's on (Tailscale may
 *   come up later, or the app may have moved to another port).
 */
import type { DiscoveredEnvironment, RemoteAccessState, TailnetPeer, TransportStatus } from "@glade/protocol";
import { getMeta, setMeta, type Db } from "../../store/db/database.js";
import { AuthError } from "../auth/auth-service.js";
import type { Transport } from "./transport.js";

/** The loopback port Glade last pointed serve at (so a restart on another port can replace it). */
export const SERVE_PORT_META_KEY = "tailscale_serve_port";

/** Does this server manage the transport? (See the header comment.) */
export function managesTransport(env: NodeJS.ProcessEnv = process.env): boolean {
  const owner = env.GLADE_TAILSCALE_OWNER ?? env.PI_UI_TAILSCALE_OWNER;
  if (owner === "1" || owner === "true") return true;
  if (owner === "0" || owner === "false") return false;
  return (env.GLADE_SERVER_KIND || env.PI_UI_SERVER_KIND) === "desktop";
}

/** The port recorded in {@link SERVE_PORT_META_KEY}, if any. */
export function lastServedPort(db: Db): number | null {
  const n = Number(getMeta(db, SERVE_PORT_META_KEY));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export interface RemoteTransportOptions {
  transport: Transport;
  db: Db;
  managed: boolean;
  /** This server's listening port (null until it listens). */
  port: () => number | null;
  /** The shared host switch. */
  isEnabled: () => boolean;
  log?: (msg: string) => void;
  /** How often to check whether the switch changed (ms); 0 = off (tests). Default 2000. */
  watchMs?: number;
  /** How often to re-read the status while remote access is on (ms). Default 30000. */
  refreshMs?: number;
}

export class RemoteTransport {
  private cached: TransportStatus | null = null;
  private lastError: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private seenEnabled: boolean | null = null;
  private lastRefresh = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: RemoteTransportOptions) {}

  get managed(): boolean {
    return this.options.managed;
  }

  /** Start watching the switch (call once the server listens). Reconciles right away. */
  start(): void {
    this.seenEnabled = this.options.isEnabled();
    void this.reconcile().catch(() => {});
    const watchMs = this.options.watchMs ?? 2000;
    if (watchMs > 0 && !this.timer) {
      this.timer = setInterval(() => void this.tick().catch(() => {}), watchMs);
      this.timer.unref();
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One watch step: react to a switch change, and refresh now and then while it's on. */
  async tick(): Promise<void> {
    const enabled = this.options.isEnabled();
    const changed = enabled !== this.seenEnabled;
    this.seenEnabled = enabled;
    if (changed || (enabled && Date.now() - this.lastRefresh >= (this.options.refreshMs ?? 30_000))) await this.reconcile();
  }

  /** The last known status (sync, for addresses and the Host allow-list). */
  current(): TransportStatus | null {
    return this.cached;
  }

  /** Base URLs remote devices can use. */
  addresses(): string[] {
    const s = this.cached;
    return s?.serving && s.dnsName && s.problem !== "funnel_on" ? [`https://${s.dnsName}`] : [];
  }

  /** Hostnames a proxied request may carry in `Host`. */
  hostnames(): string[] {
    return this.cached?.dnsName && this.cached.https ? [this.cached.dnsName] : [];
  }

  /** Read the status again. */
  refresh(): Promise<TransportStatus> {
    return this.serial(async () => this.remember(await this.options.transport.status()));
  }

  /** Managing server: make the transport match the switch. Others just refresh. */
  reconcile(): Promise<TransportStatus> {
    return this.serial(async () => {
      const port = this.options.port();
      if (!this.options.managed || port === null) return this.remember(await this.options.transport.status());
      try {
        const status = await this.options.transport.reconcile(port, this.options.isEnabled());
        if (status.serving && this.options.isEnabled()) setMeta(this.options.db, SERVE_PORT_META_KEY, String(port));
        this.lastError = undefined;
        return this.remember(status);
      } catch (err) {
        this.lastError = (err as Error).message;
        this.options.log?.(`remote access: ${this.lastError}`);
        return this.remember(await this.options.transport.status().catch(() => this.cached ?? this.fallback()));
      }
    });
  }

  /**
   * The host switch (`PATCH /api/auth/remote`). `apply` flips `meta.remote_access` (AuthService).
   * Throws `AuthError` 409 when turning on isn't possible. Read the new state with {@link withStatus}.
   */
  async setEnabled(enabled: boolean, apply: () => void): Promise<void> {
    return this.serial(async () => {
      const transport = this.options.transport;
      if (enabled) {
        const status = this.remember(await transport.status());
        if (!status.available) throw new AuthError(409, "transport_unavailable", status.reason ?? "Tailscale isn't available.");
        const port = this.options.port();
        if (this.options.managed && port !== null) {
          try {
            this.remember(await transport.enable(port));
            setMeta(this.options.db, SERVE_PORT_META_KEY, String(port));
            this.lastError = undefined;
          } catch (err) {
            this.lastError = (err as Error).message;
            throw new AuthError(409, "transport_failed", this.lastError);
          }
        }
        apply();
        this.seenEnabled = true;
        return;
      }
      apply();
      this.seenEnabled = false;
      if (this.options.managed) {
        try {
          this.remember(await transport.disable());
          this.lastError = undefined;
        } catch (err) {
          this.lastError = (err as Error).message;
          this.options.log?.(`remote access: ${this.lastError}`);
        }
      }
    });
  }

  /** The Tailscale account this machine is signed in to, read fresh (I-143 code-free pairing); null when unknown. */
  async ownLogin(): Promise<string | null> {
    const status = await this.refresh().catch(() => this.cached);
    return status?.login ?? null;
  }

  /** Glade hosts on the network (local owner only). */
  async discover(): Promise<DiscoveredEnvironment[]> {
    return (await this.options.transport.discover?.()) ?? [];
  }

  /** Machines on the network, online or not (local owner only, I-132). */
  async peers(): Promise<TailnetPeer[]> {
    return (await this.options.transport.peers?.()) ?? [];
  }

  /** `state` with the current addresses and transport status. */
  withStatus(state: RemoteAccessState): RemoteAccessState {
    const status = this.cached ?? this.fallback();
    return { ...state, transport: this.lastError ? { ...status, error: this.lastError } : status };
  }

  private remember(status: TransportStatus): TransportStatus {
    this.cached = status;
    this.lastRefresh = Date.now();
    return status;
  }

  private fallback(): TransportStatus {
    return { id: "tailscale", available: false, problem: "error", reason: "Checking Tailscale…", https: false, serving: false, managed: this.options.managed };
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
}
