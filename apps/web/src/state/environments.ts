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
 * - Remote environments come from this device's saved list and are only connected while
 *   "Connect to other Glade environments" (Settings → Remote access) is on. Turning it off closes
 *   their sockets and hides their items; nothing is deleted, and turning it on restores them.
 * - Until pairing exists (I-126), `connectEnvironmentByUrl` adds one by address (loopback only).
 *   TEMPORARY/dev: I-126 replaces it with pairing (invite link / QR / code).
 *
 * Portable client core (F-022): no layout or desktop assumptions.
 */
import { computed, effect, signal } from "@preact/signals";
import { defaultSettings, type EnvironmentInfo, type HarnessDefaults, type HarnessInfo, type ModelInfo } from "@glade/protocol";
import { api, apiBaseFromUrl, createApi, fetchEnvironmentInfo, localBaseUrl, request, type ApiClient, type RequestFn } from "@/lib/api";
import { Socket, socket as localSocket, wsUrlFromApiBase } from "@/lib/socket";
import { setChatEnvironmentResolver } from "./chat-session";
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
import { envIdOfSession, initialized, loadAll, localShell, removeEnvironmentItems } from "./store";
import { attachSync, type SyncStatus } from "./sync";

// ---------------------------------------------------------------------------------------------
// Device-local storage (per device, never synced)
// ---------------------------------------------------------------------------------------------

const KEY_REMOTE_ACCESS = "glade.remoteAccess";
const KEY_SAVED = "glade.environments";

/** Key for per-environment client state in localStorage (`glade.env.<envId>.<name>`). */
export function envStorageKey(envId: string, name: string): string {
  return `glade.env.${envId}.${name}`;
}

/** A remote environment this device knows (saved when connected; I-126 adds credentials). */
export interface SavedEnvironment {
  id: string;
  name: string;
  /** Addresses to reach it (its origin, e.g. `http://127.0.0.1:5418`), preferred first. */
  urls: string[];
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** "Connect to other Glade environments" (Settings → Remote access). Off by default. */
export const remoteAccessEnabled = signal(readJson<boolean>(KEY_REMOTE_ACCESS, false) === true);
/** Remote environments this device connects to while remote access is on. */
export const savedEnvironments = signal<SavedEnvironment[]>(readJson<SavedEnvironment[]>(KEY_SAVED, []));

export function setRemoteAccessEnabled(on: boolean): void {
  remoteAccessEnabled.value = on;
  writeStored(KEY_REMOTE_ACCESS, JSON.stringify(on));
}

function saveEnvironments(list: SavedEnvironment[]): void {
  savedEnvironments.value = list;
  writeStored(KEY_SAVED, JSON.stringify(list));
}

export function removeSavedEnvironment(id: string): void {
  saveEnvironments(savedEnvironments.value.filter((e) => e.id !== id));
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
  readonly name = computed(() => this.info.value?.name ?? this.savedName ?? hostOf(this.baseUrl));
  readonly api: ApiClient;
  readonly request: RequestFn;
  readonly socket: Socket;
  readonly shell: EnvShell;
  private detach: (() => void) | null = null;

  constructor(
    readonly id: string,
    readonly baseUrl: string,
    readonly isLocal: boolean,
    private readonly savedName?: string,
  ) {
    // The page's own server uses the shared local client and socket (`lib/api`, `lib/socket`).
    const pageServer = isLocal && baseUrl === localBaseUrl();
    this.api = pageServer ? api : createApi(baseUrl);
    this.request = pageServer ? request : this.api.request;
    this.socket = pageServer ? localSocket : new Socket(wsUrlFromApiBase(baseUrl));
    this.shell = isLocal ? localShell : newShell();
  }

  /** Connect the socket, subscribe and load the first paint over HTTP. */
  start(): void {
    if (this.detach) return;
    this.detach = attachSync(this.socket, this.id, (s) => {
      this.status.value = STATUS[s];
    });
    this.socket.connect();
    void loadAll(this.id).then(() => {
      if (this.shell.initError.value && this.status.value !== "live") this.status.value = "error";
    });
    if (!this.info.value) {
      void this.api.getEnvironment().then(
        (info) => {
          // A different server answers at this address now: don't mix its data in.
          if (!this.isLocal && info.id !== this.id) {
            this.status.value = "error";
            this.stop();
            return;
          }
          this.info.value = info;
        },
        () => {
          /* older server: no info (name falls back to the saved one) */
        },
      );
    }
  }

  /** Close the socket and hide this environment's items (nothing is deleted). */
  stop(): void {
    this.detach?.();
    this.detach = null;
    this.socket.disconnect();
    removeEnvironmentItems(this.id);
  }
}

/** A usable `GET /api/environment` answer (older servers answer 404 or something else). */
function isEnvironmentInfo(value: unknown): value is EnvironmentInfo {
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
  } else {
    // Zero local environments (F-022): nothing to wait for; remote ones fill in as they connect.
    hasLocalEnvironment.value = false;
    localEnvironmentId.value = null;
    initialized.value = true;
  }
  stopReconcile = effect(() => reconcileRemotes(remoteAccessEnabled.value, savedEnvironments.value));
}

/** Remote connections = the saved list while remote access is on; nothing otherwise. */
function reconcileRemotes(enabled: boolean, saved: SavedEnvironment[]): void {
  const localId = localEnvironmentId.value;
  const wanted = enabled ? saved.filter((e) => e.id !== localId && e.urls.length > 0) : [];
  const current = connections.value;
  const keep = current.filter((c) => c.isLocal || wanted.some((w) => w.id === c.id));
  for (const c of current) if (!keep.includes(c)) (c as EnvironmentConnection).stop();
  const added: EnvironmentConnection[] = [];
  for (const entry of wanted) {
    if (keep.some((c) => c.id === entry.id)) continue;
    added.push(new EnvironmentConnection(entry.id, apiBaseFromUrl(entry.urls[0]!), false, entry.name));
  }
  if (added.length === 0 && keep.length === current.length) return;
  connections.value = [...keep, ...added];
  for (const c of added) c.start();
}

/** Tests: stop every connection and forget startup. */
export function resetEnvironments(): void {
  stopReconcile?.();
  stopReconcile = null;
  for (const c of connections.value) if (c instanceof EnvironmentConnection && !c.isLocal) c.stop();
  connections.value = [];
  localEnvironmentId.value = null;
  hasLocalEnvironment.value = true;
  started = false;
}

// ---------------------------------------------------------------------------------------------
// TEMPORARY (dev) until pairing (I-126): connect to an environment by address.
// ---------------------------------------------------------------------------------------------

/** Loopback only for now: remote hosts need auth first (I-125/I-126). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const { hostname, protocol } = new URL(url);
    return (protocol === "http:" || protocol === "https:") && (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]");
  } catch {
    return false;
  }
}

/**
 * Fetch `GET /api/environment` at `url` and save it to this device's list. Throws with a
 * message for the dialog. TEMPORARY: I-126 (pairing) replaces this.
 */
export async function connectEnvironmentByUrl(url: string): Promise<SavedEnvironment> {
  const trimmed = url.trim();
  if (!isLoopbackUrl(trimmed)) throw new Error("Only local addresses (http://127.0.0.1:…) for now; pairing comes later.");
  const base = apiBaseFromUrl(trimmed);
  const info = await fetchEnvironmentInfo(base).catch((err: Error) => {
    throw new Error(`No Glade environment answered at ${new URL(base).origin} (${err.message}).`);
  });
  if (!isEnvironmentInfo(info)) throw new Error(`No Glade environment answered at ${new URL(base).origin}.`);
  if (info.id === localEnvironmentId.value) throw new Error("That's this environment.");
  const entry: SavedEnvironment = { id: info.id, name: info.name, urls: [new URL(base).origin] };
  saveEnvironments([...savedEnvironments.value.filter((e) => e.id !== info.id), entry]);
  return entry;
}
