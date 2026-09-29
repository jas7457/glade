/**
 * Environment connections (I-123, design docs/design/environments-and-store.md §3.3/§5): the app
 * is a client of zero or more Glade servers ("environments"). Each `EnvironmentConnection` has
 * its absolute API base URL, its info (`GET /api/environment`), its own socket with the I-122
 * sync state, a status and its own shell data (settings, models, harnesses; the projects,
 * workspaces and sessions are merged into the stores, tagged by environment).
 *
 * - The *local* environment is the server that served this page; it's simply the first
 *   connection, and doesn't exist at all for a pure client (the iPhone app, F-022:
 *   `startEnvironments({ localBaseUrl: null })`).
 * - Remote environments come from this device's saved list and are only connected while the
 *   "Remote access" master switch (Settings → Remote Access, I-132, `state/remote-master.ts`) is
 *   on. Turning it off closes their sockets and hides their items; nothing is deleted, and
 *   turning it on restores them.
 * - I-132: while a remote environment is down (remote access off there, offline, unreachable,
 *   needs pairing: `state/remote-status.ts`) its projects and chats are hidden; the sidebar and
 *   Settings show its status instead. They come back with the next sync once it reconnects. A
 *   single dropped connection counts as "connecting" until a reconnect attempt fails too.
 * - Environments are added by pairing (I-126, `state/pairing.ts`); each saved entry carries its
 *   device token (`state/saved-environments.ts`; kept in the Keychain in the Mac app, I-134).
 *   Requests send it as a bearer token, the socket gets a fresh ticket per connect (I-125). A 401 turns the environment to "needs-pairing"
 *   (no more retries), a 403 `remote_disabled` to "remote-disabled" (slow retries, remembered in
 *   the saved list until the host answers again).
 *
 * Portable client core (F-022): no layout or desktop assumptions.
 */
import { computed, effect, signal } from "@preact/signals";
import { defaultSettings, type EnvironmentInfo, type HarnessDefaults, type HarnessInfo, type ModelInfo } from "@glade/protocol";
import {
  api,
  apiBaseFromUrl,
  createApi,
  fetchEnvironmentInfo,
  isRemoteDisabled,
  isUnauthorized,
  localBaseUrl,
  request,
  requestAt,
  type ApiClient,
  type RequestFn,
} from "@/lib/api";
import { Socket, socket as localSocket, wsUrlFromApiBase, type SocketAuthError } from "@/lib/socket";
import { setChatEnvironmentResolver } from "./chat-session";
import { connectionName } from "./connections";
import { apiFor } from "./env-api";
import {
  LOCAL_FALLBACK_ID,
  connectionFor,
  connections,
  hasLocalEnvironment,
  localEnvironmentId,
  type EnvHandle,
  type EnvShell,
  type EnvStatus,
} from "./env-registry";
import { loadRemoteMaster, remoteMaster, setRemoteMaster, useServerMaster } from "./remote-master";
import { downEnvironments, refreshPeersIfNeeded, watchPeers } from "./remote-status";
import { environmentAlias, loadSavedEnvironments, savedEnvironments, setRemoteDisabled, type SavedEnvironment } from "./saved-environments";
import { envIdOfSession, initialized, loadAll, localShell, removeEnvironmentItems } from "./store";
import { attachSync, type SyncStatus } from "./sync";

// ---------------------------------------------------------------------------------------------
// Device-local storage (per device, never synced)
// ---------------------------------------------------------------------------------------------

/** Key for per-environment client state in localStorage (`glade.env.<envId>.<name>`). */
export function envStorageKey(envId: string, name: string): string {
  return `glade.env.${envId}.${name}`;
}

export { savedEnvironments, removeSavedEnvironment, upsertSavedEnvironment, type SavedEnvironment } from "./saved-environments";

/**
 * The "Remote access" master switch (I-132; stored on the local server, `state/remote-master.ts`).
 * Kept under the old names too: it replaced the per-device "Connect to other Glade environments".
 */
export { remoteMaster, remoteMaster as remoteAccessEnabled, setRemoteMaster } from "./remote-master";
export function setRemoteAccessEnabled(on: boolean): void {
  void setRemoteMaster(on);
}

// ---------------------------------------------------------------------------------------------
// A connection
// ---------------------------------------------------------------------------------------------

function newShell(): EnvShell {
  return {
    settings: signal(defaultSettings()),
    models: signal<ModelInfo[]>([]),
    harnessDefaults: signal<HarnessDefaults | null>(null),
    harnesses: signal<HarnessInfo[] | null>(null),
    initialized: signal(false),
    initError: signal<string | null>(null),
  };
}

const STATUS: Record<SyncStatus, EnvStatus> = { connecting: "connecting", "catching-up": "connecting", live: "live", offline: "offline" };

export class EnvironmentConnection implements EnvHandle {
  readonly info = signal<EnvironmentInfo | null>(null);
  readonly status = signal<EnvStatus>("connecting");
  /** The name shown everywhere (I-138): this device's alias for it, else its own name. */
  readonly name = computed(() =>
    connectionName({ alias: this.isLocal ? null : environmentAlias(this.id), ownName: this.info.value?.name, fallback: this.savedName ?? hostOf(this.baseUrl) }),
  );
  readonly api: ApiClient;
  readonly request: RequestFn;
  readonly socket: Socket;
  readonly shell: EnvShell;
  private detach: (() => void) | null = null;
  /** Connection attempts that failed in a row (a single drop still counts as "connecting"). */
  private failures = 0;
  private offSocket: Array<() => void> = [];

  constructor(
    readonly id: string,
    readonly baseUrl: string,
    readonly isLocal: boolean,
    private readonly savedName?: string,
    /** Device token (I-125); remote environments saved before pairing have none. */
    readonly token: string | null = null,
  ) {
    // The page's own server uses the shared local client and socket (`lib/api`, `lib/socket`).
    const pageServer = isLocal && baseUrl === localBaseUrl();
    this.api = pageServer ? api : createApi(baseUrl, { token: () => this.token, onAuthError: (err) => this.authFailed(isUnauthorized(err) ? "unauthorized" : "remote_disabled") });
    this.request = pageServer ? request : this.api.request;
    this.socket = pageServer ? localSocket : new Socket(this.token ? () => this.socketUrl() : wsUrlFromApiBase(baseUrl));
    this.shell = isLocal ? localShell : newShell();
    if (!pageServer) {
      this.socket.onAuthError((e) => this.authFailed(e));
      this.offSocket.push(
        this.socket.onOpen(() => (this.failures = 0)),
        this.socket.onClose(() => this.failures++),
      );
    }
  }

  /** A fresh single-use ticket for every socket connect (I-125); long-lived tokens stay out of URLs. */
  private async socketUrl(): Promise<string> {
    const { ticket } = await requestAt<{ ticket: string; expiresAt: number }>(this.baseUrl, "POST", "/auth/ws-ticket", undefined, undefined, { token: this.token });
    return `${wsUrlFromApiBase(this.baseUrl)}?ticket=${encodeURIComponent(ticket)}`;
  }

  /** The host refused this device: stop for a dead token, wait (the socket retries slowly) when remote access is off. */
  private authFailed(error: SocketAuthError): void {
    if (this.stopped) return;
    if (error === "unauthorized") {
      this.status.value = "needs-pairing";
      this.detach?.();
      this.detach = null;
      this.socket.disconnect();
    } else {
      this.status.value = "remote-disabled";
      if (!this.isLocal) setRemoteDisabled(this.id, true);
    }
  }

  private stopped = false;

  /** Connect the socket, subscribe and load the first paint over HTTP. */
  start(): void {
    if (this.detach) return;
    this.stopped = false;
    this.detach = attachSync(this.socket, this.id, (s) => {
      // Auth states stick until the host answers again (a live sync clears them).
      if (s !== "live" && (this.status.value === "needs-pairing" || this.status.value === "remote-disabled")) return;
      // One drop is a blip: say "connecting" until a reconnect attempt fails too.
      this.status.value = s === "offline" && this.failures < 2 ? "connecting" : STATUS[s];
      if (s === "live" && !this.isLocal) setRemoteDisabled(this.id, false);
    });
    this.socket.connect();
    void loadAll(this.id).then(() => {
      if (this.shell.initError.value && this.status.value !== "live" && !isAuthStatus(this.status.value)) this.status.value = "error";
    });
    if (!this.info.value) {
      void this.api.getEnvironment().then(
        (info) => {
          if (this.stopped) return;
          // A different server answers at this address now: don't mix its data in.
          if (!this.isLocal && info.id !== this.id) {
            this.status.value = "error";
            this.stop();
            return;
          }
          this.info.value = info;
        },
        (err: unknown) => {
          // Older server: no info (name falls back to the saved one). Auth errors set the status.
          if (isUnauthorized(err) || isRemoteDisabled(err)) return;
        },
      );
    }
  }

  /** Try again now (Retry): a fresh connection, without waiting for the backoff. */
  retry(): void {
    if (this.isLocal || this.status.value === "needs-pairing") return;
    this.stop();
    this.failures = 0;
    this.status.value = "connecting";
    this.start();
  }

  /** If the socket waits to reconnect (backoff, remote access off), try now (I-142). */
  retryNow(): boolean {
    if (this.isLocal || this.stopped || this.status.value === "needs-pairing" || this.status.value === "live") return false;
    return this.socket.retryNow();
  }

  /** Close the socket and hide this environment's items (nothing is deleted). */
  stop(): void {
    this.stopped = true;
    this.detach?.();
    this.detach = null;
    this.socket.disconnect();
    removeEnvironmentItems(this.id);
  }
}

function isAuthStatus(status: EnvStatus): boolean {
  return status === "needs-pairing" || status === "remote-disabled";
}

/** A usable `GET /api/environment` answer (older servers answer 404 or something else). */
export function isEnvironmentInfo(value: unknown): value is EnvironmentInfo {
  return !!value && typeof value === "object" && typeof (value as EnvironmentInfo).id === "string" && (value as EnvironmentInfo).id.length > 0;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Display address of an environment (its origin). */
export function environmentAddress(env: EnvHandle): string {
  try {
    return new URL(env.baseUrl).origin;
  } catch {
    return env.baseUrl;
  }
}

// ---------------------------------------------------------------------------------------------
// Startup + reconciling the remote connections
// ---------------------------------------------------------------------------------------------

let started = false;
let stopReconcile: (() => void) | null = null;

export interface StartOptions {
  /** API base of the server that served the page; `null` = no local environment (phone). */
  localBaseUrl: string | null;
}

/**
 * Connect the local environment (if any), then keep the remote connections matching the saved
 * list and the remote-access switch. Call once at startup.
 */
export async function startEnvironments(options: StartOptions = { localBaseUrl: localBaseUrl() }): Promise<void> {
  if (started) return;
  started = true;
  // Device tokens come from the Keychain / secret store (I-134); remote connections wait for them.
  const tokensLoaded = loadSavedEnvironments();
  setChatEnvironmentResolver({
    api: (sessionId) => apiFor(envIdOfSession(sessionId)),
    watch: (sessionId) => (connectionFor(envIdOfSession(sessionId))?.socket ?? localSocket).watch(sessionId),
  });
  if (options.localBaseUrl) {
    hasLocalEnvironment.value = true;
    const answer = await fetchEnvironmentInfo(options.localBaseUrl).catch(() => null);
    const info = isEnvironmentInfo(answer) ? answer : null;
    const local = new EnvironmentConnection(info?.id ?? LOCAL_FALLBACK_ID, options.localBaseUrl, true);
    local.info.value = info;
    localEnvironmentId.value = local.id;
    connections.value = [local];
    local.start();
    // I-132: the master switch lives on this server; re-read it when this window comes back.
    useServerMaster();
    void loadRemoteMaster();
    stopPeers = watchPeers();
  } else {
    // Zero local environments (F-022): nothing to wait for; remote ones fill in as they connect.
    hasLocalEnvironment.value = false;
    localEnvironmentId.value = null;
    initialized.value = true;
  }
  await tokensLoaded;
  if (!started) return; // reset meanwhile (tests)
  stopReconcile = effect(() => reconcileRemotes(remoteMaster.value, savedEnvironments.value));
  stopHiding = effect(() => hideDown(downEnvironments.value));
  if (typeof window !== "undefined") window.addEventListener("focus", onFocus);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
}

/**
 * I-142: remote environments waiting to reconnect (remote access off there, unreachable) try
 * again right away; `ids` limits it to those environments. Returns the ids that retried.
 */
export function retryWaitingRemotes(ids?: Iterable<string>): string[] {
  const only = ids ? new Set(ids) : null;
  const retried: string[] = [];
  for (const c of connections.value) {
    if (c.isLocal || (only && !only.has(c.id))) continue;
    if (c.retryNow?.()) retried.push(c.id);
  }
  return retried;
}

/**
 * The window came back (focus / visible): re-read the master switch (local server), retry
 * waiting remotes and refresh the tailnet peers (I-142).
 */
function onWindowBack(): void {
  if (hasLocalEnvironment.value) {
    void loadRemoteMaster();
    void refreshPeersIfNeeded();
  }
  retryWaitingRemotes();
}
const onFocus = () => onWindowBack();
const onVisibility = () => {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") onWindowBack();
};
let stopPeers: (() => void) | null = null;
let stopHiding: (() => void) | null = null;
let hidden = new Set<string>();

/** Environments that just went down lose their items (they come back with the next sync). */
function hideDown(down: ReadonlySet<string>): void {
  for (const id of down) if (!hidden.has(id)) removeEnvironmentItems(id);
  hidden = new Set(down);
}

/** Remote connections = the saved list while remote access is on; nothing otherwise. */
function reconcileRemotes(enabled: boolean, saved: SavedEnvironment[]): void {
  const localId = localEnvironmentId.value;
  const wanted = enabled ? saved.filter((e) => e.id !== localId && e.urls.length > 0) : [];
  const current = connections.value;
  // A new token (paired again) or first address means a new connection.
  const same = (c: EnvHandle, w: SavedEnvironment) =>
    c.id === w.id && (!(c instanceof EnvironmentConnection) || (c.token === (w.token ?? null) && c.baseUrl === apiBaseFromUrl(w.urls[0]!)));
  const keep = current.filter((c) => c.isLocal || wanted.some((w) => same(c, w)));
  for (const c of current) if (!keep.includes(c)) (c as EnvironmentConnection).stop();
  const added: EnvironmentConnection[] = [];
  for (const entry of wanted) {
    if (keep.some((c) => c.id === entry.id)) continue;
    added.push(new EnvironmentConnection(entry.id, apiBaseFromUrl(entry.urls[0]!), false, entry.name, entry.token ?? null));
  }
  if (added.length === 0 && keep.length === current.length) return;
  connections.value = [...keep, ...added];
  for (const c of added) c.start();
}

/** Tests: stop every connection and forget startup. */
export function resetEnvironments(): void {
  stopReconcile?.();
  stopReconcile = null;
  stopHiding?.();
  stopHiding = null;
  hidden = new Set();
  stopPeers?.();
  stopPeers = null;
  if (typeof window !== "undefined") window.removeEventListener("focus", onFocus);
  if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  for (const c of connections.value) if (c instanceof EnvironmentConnection && !c.isLocal) c.stop();
  connections.value = [];
  localEnvironmentId.value = null;
  hasLocalEnvironment.value = true;
  started = false;
}
