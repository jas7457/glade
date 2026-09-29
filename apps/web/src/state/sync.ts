/**
 * Sequenced live sync with the server (I-122; protocol in `@glade/protocol` sync.ts).
 *
 * The shell scope (projects, workspaces, sessions, settings) is always subscribed; every mounted
 * chat subscribes its session scope. Each scope remembers the last seq it has. On every
 * (re)connect the client subscribes again from there: the server replays what was missed or
 * sends a snapshot, then `live`. There is no full reload on reconnect. Duplicates (seq already
 * seen) are dropped; a gap re-subscribes from the last seq. The shell's `live` carries every id
 * the server has, so a stale list is corrected after every reconnect. `syncStatus` is "live" only
 * once the shell caught up.
 *
 * {@link SyncController} is the pure part (tests drive it); `startSync` wires it to the socket,
 * the stores and the chat sessions.
 */
import { signal } from "@preact/signals";
import {
  SYNC_PROTOCOL,
  classifySeq,
  type ClientMessage,
  type MessagePatch,
  type ServerMessage,
  type SessionLiveState,
  type ShellSnapshot,
  type ToolResult,
  type TranscriptPage,
  type AgentEvent,
} from "@glade/protocol";
import { socket } from "@/lib/socket";
import * as chat from "./chat-session";
import * as store from "./store";
import { isLocalEnvironment } from "./env-registry";
import { observeSessionUpsert } from "./notifications";

/** "live" = connected and caught up; "catching-up" = connected, replay/snapshot on its way. */
export type SyncStatus = "connecting" | "catching-up" | "live" | "offline";

/** The local (primary) environment's sync status; each connection has its own `status`. */
export const syncStatus = signal<SyncStatus>("connecting");

/** Where synced changes go (the app's stores; a recorder in tests). */
export interface SyncTarget {
  send(message: ClientMessage): void;
  /**
   * A shell push (`*_upsert`, `settings`, …) or an untagged one (`open_chat`, `usage_limits`, …).
   * `live`: it arrived after the shell's `live` marker (a change happening now, not a replay), so
   * it may raise a system notification (I-135).
   */
  applyShell(message: ServerMessage, live: boolean): void;
  applyShellSnapshot(shell: ShellSnapshot): void;
  /** Returns true when the server has ids we don't (the client then asks for a snapshot). */
  applyShellCheck(check: { projects: string[]; workspaces: string[]; sessions: string[]; folders?: string[] }): boolean;
  applySessionEvent(sessionId: string, event: AgentEvent): void;
  applySessionSnapshot(sessionId: string, page: TranscriptPage, live: SessionLiveState): void;
  applySessionLive(sessionId: string, live: SessionLiveState): void;
  /** False when the patch doesn't fit what's loaded (the client then asks for a snapshot). */
  applyTranscriptPatch(sessionId: string, messages: MessagePatch[], toolResults: ToolResult[]): boolean;
  applySessionError(sessionId: string, error: string): void;
  /** Whether a session may subscribe now (not while its HTTP load is running). */
  canSubscribe?(sessionId: string): boolean;
  /** Server without sequenced sync: reload everything after a reconnect (the old way). */
  legacyReload?(): void;
  setStatus?(status: SyncStatus): void;
}

interface Scope {
  /** Last seq this scope has (`null`: nothing yet: only a snapshot counts). */
  last: number | null;
  phase: "idle" | "subscribing" | "live";
}

interface SessionScope extends Scope {
  refs: number;
}

export class SyncController {
  private readonly shell: Scope = { last: null, phase: "idle" };
  private readonly sessions = new Map<string, SessionScope>();
  private open = false;
  /** The server speaks protocol 2 (from `hello`). */
  private sequenced = false;
  private everConnected = false;

  constructor(private readonly target: SyncTarget) {}

  // Connection -------------------------------------------------------------------------------

  /** A connection opened; subscriptions follow the server's `hello`. */
  onOpen(): void {
    this.open = true;
    this.setStatus("catching-up");
  }

  onClose(): void {
    this.open = false;
    this.shell.phase = "idle";
    for (const scope of this.sessions.values()) scope.phase = "idle";
    this.setStatus("offline");
  }

  private hello(protocol: number | undefined): void {
    const reconnect = this.everConnected;
    this.everConnected = true;
    this.sequenced = (protocol ?? 1) >= SYNC_PROTOCOL;
    if (!this.sequenced) {
      if (reconnect) this.target.legacyReload?.();
      this.setStatus("live");
      return;
    }
    this.subscribeShell();
    for (const [id, scope] of this.sessions) if (scope.refs > 0) this.subscribeSession(id);
  }

  private setStatus(status: SyncStatus): void {
    this.target.setStatus?.(status);
  }

  // Subscriptions ------------------------------------------------------------------------------

  private subscribeShell(fresh = false): void {
    if (!this.open || !this.sequenced) return;
    if (fresh) this.shell.last = null;
    this.shell.phase = "subscribing";
    this.target.send({ type: "subscribe", scope: "shell", ...(this.shell.last !== null ? { afterSeq: this.shell.last } : {}) });
  }

  private subscribeSession(sessionId: string, fresh = false): void {
    const scope = this.sessions.get(sessionId);
    if (!scope || scope.refs <= 0 || !this.open || !this.sequenced) return;
    if (this.target.canSubscribe && !this.target.canSubscribe(sessionId)) return;
    if (fresh) scope.last = null;
    scope.phase = "subscribing";
    this.target.send({ type: "subscribe", scope: "session", sessionId, ...(scope.last !== null ? { afterSeq: scope.last } : {}) });
  }

  /** A chat is on screen: keep its transcript in sync until the returned function is called. */
  retain(sessionId: string): () => void {
    let scope = this.sessions.get(sessionId);
    if (!scope) {
      scope = { last: null, phase: "idle", refs: 0 };
      this.sessions.set(sessionId, scope);
    }
    scope.refs++;
    if (scope.phase === "idle") this.subscribeSession(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.sessions.get(sessionId);
      if (!current || --current.refs > 0) return;
      // Its `last` is kept: showing it again replays only what changed meanwhile.
      if (this.open && this.sequenced && current.phase !== "idle") this.target.send({ type: "unsubscribe", scope: "session", sessionId });
      current.phase = "idle";
    };
  }

  /** The chat was loaded over HTTP as of `seq`: continue from there. */
  seed(sessionId: string, seq: number | null): void {
    let scope = this.sessions.get(sessionId);
    if (!scope) {
      scope = { last: null, phase: "idle", refs: 0 };
      this.sessions.set(sessionId, scope);
    }
    scope.last = seq;
    this.subscribeSession(sessionId);
  }

  /** Start a session over with a snapshot. */
  restart(sessionId: string): void {
    this.subscribeSession(sessionId, true);
  }

  /** Shell pushes are live changes now (after `live`; old servers without replay: while open). */
  shellLive(): boolean {
    return this.open && (this.sequenced ? this.shell.phase === "live" : this.everConnected);
  }

  /** Last seq of a scope (tests, diagnostics). */
  lastSeq(scope: "shell" | string): number | null {
    return scope === "shell" ? this.shell.last : (this.sessions.get(scope)?.last ?? null);
  }

  // Receiving --------------------------------------------------------------------------------

  receive(message: ServerMessage): void {
    switch (message.type) {
      case "batch":
        for (const m of message.messages) this.receive(m);
        return;
      case "hello":
        this.hello(message.protocol);
        return;
      case "ping":
      case "pong":
        return;
      case "subscribe_error": {
        const scope = this.sessions.get(message.sessionId);
        if (scope) scope.phase = "idle";
        this.target.applySessionError(message.sessionId, message.error);
        return;
      }
      case "snapshot":
        if (message.scope === "shell") {
          this.target.applyShellSnapshot(message.shell);
          this.shell.last = message.seq;
        } else {
          const scope = this.sessions.get(message.sessionId);
          if (!scope || scope.phase === "idle") return;
          this.target.applySessionSnapshot(message.sessionId, message.page, message);
          scope.last = message.seq;
        }
        return;
      case "live":
        if (message.scope === "shell") {
          this.shell.last = message.seq;
          this.shell.phase = "live";
          if (this.target.applyShellCheck(message.check)) {
            this.subscribeShell(true);
            return;
          }
          if (this.open) this.setStatus("live");
        } else {
          const scope = this.sessions.get(message.sessionId);
          if (!scope || scope.phase === "idle") return;
          scope.last = message.seq;
          scope.phase = "live";
          this.target.applySessionLive(message.sessionId, message);
        }
        return;
      default:
        break;
    }
    const sessionId = sessionScopeOf(message);
    if (sessionId === null) return this.receiveShell(message);
    const scope = this.sessions.get(sessionId);
    if (!scope || scope.phase === "idle") {
      // Not subscribed: only untagged notices (toasts) matter.
      if (message.seq === undefined && message.type === "session_event") this.target.applySessionEvent(sessionId, message.event);
      return;
    }
    if (message.seq === undefined && message.type === "session_event" && message.event.type !== "notify" && this.sequenced) return; // pre-subscribe leftovers
    if (!this.accept(scope, message, () => this.subscribeSession(sessionId))) return;
    switch (message.type) {
      case "session_event":
        this.target.applySessionEvent(sessionId, message.event);
        break;
      case "transcript_patch":
        if (!this.target.applyTranscriptPatch(sessionId, message.messages, message.toolResults)) this.subscribeSession(sessionId, true);
        break;
      default:
        break; // session_sync: only the seq
    }
  }

  private receiveShell(message: ServerMessage): void {
    if (!this.accept(this.shell, message, () => this.subscribeShell())) return;
    this.target.applyShell(message, this.shellLive());
  }

  /** The duplicate/gap rule; advances `last` for committed pushes. */
  private accept(scope: Scope, message: ServerMessage, resubscribe: () => void): boolean {
    const verdict = classifySeq(scope.last, message);
    if (verdict === "gap") {
      // Already asking for a replay: the pushes in between are covered by it.
      if (scope.phase !== "subscribing") resubscribe();
      return false;
    }
    if (verdict === "drop") return false;
    if (message.prev !== undefined && message.seq !== undefined) scope.last = message.seq;
    return true;
  }
}

/** The session a push belongs to (`null`: shell scope, or untagged app-wide pushes). */
function sessionScopeOf(message: ServerMessage): string | null {
  switch (message.type) {
    case "session_event":
      return message.event.type === "notify" && message.seq === undefined ? null : message.sessionId;
    case "transcript_patch":
    case "session_sync":
      return message.sessionId;
    default:
      return null;
  }
}

// Wiring ---------------------------------------------------------------------------------------
// One SyncController per environment (I-123), each on that environment's socket and feeding the
// merged stores with its items tagged by environment.

/** Controllers by environment id (`""`: the untagged local one of `startSync`). */
const controllers = new Map<string, SyncController>();

/** The socket side a controller needs (a `Socket`, or a fake in tests). */
export interface SyncSocket {
  send(message: ClientMessage): void;
  onMessage(handler: (message: ServerMessage) => void): () => void;
  onOpen(handler: () => void): () => void;
  onClose(handler: () => void): () => void;
}

/** The environment of a session's controller (falls back to the only/untagged one). */
function controllerForSession(sessionId: string): SyncController | undefined {
  const env = store.envIdOfSession(sessionId);
  return controllers.get(env) ?? controllers.get("") ?? (controllers.size === 1 ? [...controllers.values()][0] : undefined);
}

let hooksInstalled = false;
function installChatHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  chat.setChatSyncHooks({
    retain: (id) => controllerForSession(id)?.retain(id) ?? (() => {}),
    seed: (id, seq) => controllerForSession(id)?.seed(id, seq),
    restart: (id) => controllerForSession(id)?.restart(id),
  });
}

/**
 * Keep one environment in sync over its socket. `envId` undefined: the local environment with
 * untagged items (`startSync`). `onStatus` reports every status change. Returns a disposer.
 */
export function attachSync(socket: SyncSocket, envId: string | undefined, onStatus?: (status: SyncStatus) => void): () => void {
  const key = envId ?? "";
  const sync = new SyncController({
    send: (m) => socket.send(m),
    applyShell: (m, live) => {
      // System notifications (I-135) compare the session before and after a live push.
      const prev = live && m.type === "session_upsert" ? store.sessionsById.value.get(m.session.id) : undefined;
      store.handleServerMessage(m, envId);
      if (live && m.type === "session_upsert") observeSessionUpsert(prev, m.session, envId);
    },
    applyShellSnapshot: (shell) => store.applyShellSnapshot(shell, envId),
    applyShellCheck: (check) => store.applyShellCheck(check, envId),
    applySessionEvent: chat.handleSessionEvent,
    applySessionSnapshot: chat.applySessionSnapshot,
    applySessionLive: chat.applySessionLive,
    applyTranscriptPatch: chat.applyTranscriptPatch,
    applySessionError: chat.applySessionError,
    canSubscribe: (id) => chat.getChatSession(id).status.value !== "loading",
    legacyReload: () => {
      void store.loadAll(envId);
      void chat.reloadOpenChatSessions((id) => envId === undefined || store.envIdOfSession(id) === envId);
    },
    setStatus: (status) => {
      if (envId === undefined || isLocalEnvironment(envId) || controllers.size === 1) syncStatus.value = status;
      onStatus?.(status);
    },
  });
  controllers.set(key, sync);
  installChatHooks();
  const offs = [socket.onMessage((m) => sync.receive(m)), socket.onOpen(() => sync.onOpen()), socket.onClose(() => sync.onClose())];
  return () => {
    offs.forEach((off) => off?.());
    if (controllers.get(key) === sync) controllers.delete(key);
  };
}

/** Local-only sync (tests; a page without environments): connect, subscribe and load. */
export function startSync(): void {
  if (controllers.size > 0) return;
  attachSync(socket, undefined);
  socket.connect();
  // First paint over HTTP; the shell snapshot replaces it (and wins if it comes first).
  void store.loadAll();
}
