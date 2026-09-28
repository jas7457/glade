/**
 * Sequenced live sync to every connected client (I-122; protocol in `@glade/protocol` sync.ts).
 *
 * The model:
 * - **The event log is the sequence.** Every change a client can see is a row in `events`
 *   (`Store`), committed with the change. The store hands the hub every committed row in seq
 *   order (`Store.onEvents`): this server's right after the write, other servers' when its poll
 *   finds them (I-062), so a client of this server sees theirs with their seqs too.
 * - **Shell scope** (projects, workspaces, sessions, settings, agents, the environment): rows mark entities dirty;
 *   every ~50 ms the dirty entities are read once (current record and live summary) and sent as
 *   the usual `*_upsert` / `*_removed` pushes, tagged `seq` (the entity's newest row) and `prev`.
 *   Pushes the app makes without a row (live status, leases elsewhere) mark entities dirty too and
 *   go out as ephemeral (`seq` only).
 * - **Session scope** (one chat's transcript): the live stream stays the `session_event`s (every
 *   delta), tagged with the seq they're based on. The event log stores coalesced message
 *   snapshots (`TranscriptWriter`, ≤ 250 ms apart, at once when a message/tool/run ends); for
 *   those rows a live client only gets a `session_sync` marker (it has the content from the
 *   stream). Rows written by another server, or not pushed as events, go out as a
 *   `transcript_patch` with the rows' messages. A replay after `afterSeq` is one patch of every
 *   message changed since, so it ends in the same state as the stream.
 * - **Subscribe** replays after `afterSeq`, or sends a `snapshot` (gap > `maxReplay` rows, pruned,
 *   `afterSeq` missing or ahead of the log, or a harness import reshuffled the transcript), then
 *   `live`. Per client, pushes are queued and sent as one `batch` every `batchMs`; when the queue
 *   plus the socket's own buffer exceed `budgetBytes`, the queue is dropped and the client gets
 *   snapshots once its socket drained. Pings every `pingMs`; a client silent for `deadMs` is closed.
 */
import {
  pageOf,
  type EventRow,
  type Store,
} from "../../store/store.js";
import type {
  EnvironmentInfo,
  ServerMessage,
  SessionLiveState,
  SessionSummary,
  ShellSnapshot,
  Transcript,
  WorkspaceSummary,
} from "@glade/protocol";

/** What the hub needs from the app (wired by `AppService`). */
export interface SyncSource {
  readonly store: Store;
  shellSnapshot(): ShellSnapshot;
  /** This server's environment (I-123), for `environment` pushes after a rename. */
  environmentInfo?(): EnvironmentInfo;
  sessionSummary(id: string): SessionSummary | null;
  workspaceSummary(id: string): WorkspaceSummary | null;
  /** Sessions whose live status isn't idle (running, waiting for input, busy elsewhere). */
  activeSessionSummaries(): SessionSummary[];
  /**
   * Get a session ready to sync, like opening it (import, start its agent unless another server
   * holds it or it's a closed sub-agent). Resolves to a synchronous reader of its current state;
   * calling it writes pending transcript changes first, so the store equals `transcript`.
   */
  prepareSession(id: string): Promise<() => SessionSyncView>;
  /** Receive what the app broadcasts (`AppService.subscribe`); returns the unsubscribe. */
  subscribe(listener: (message: ServerMessage) => void): () => void;
  log?(msg: string): void;
}

export interface SessionSyncView extends SessionLiveState {
  transcript: Transcript;
}

export interface SyncOptions {
  /** Batching interval (ms). Default 50. */
  batchMs?: number;
  /** Ping interval (ms). Default 20 s. */
  pingMs?: number;
  /** A client that sent nothing (not even a pong) this long is closed. Default 45 s. */
  deadMs?: number;
  /** Queue + socket buffer limit per client before falling back to snapshots. Default 4 MB. */
  budgetBytes?: number;
  /** More rows than this since `afterSeq` → snapshot. Default 1000. */
  maxReplay?: number;
  /** Turns in a session snapshot (older ones: `GET /sessions/:id/transcript`). Default 50. */
  snapshotTurns?: number;
}

/** The socket as the hub sees it (`ws` behind hono's `WSContext`, or a test double). */
export interface SyncSocket {
  send(data: string): void;
  /** Bytes queued in the socket but not sent yet. */
  bufferedAmount(): number;
  close(): void;
}

type Resolved = Required<SyncOptions>;

const DEFAULTS: Resolved = {
  batchMs: 50,
  pingMs: 20_000,
  deadMs: 45_000,
  budgetBytes: 4 * 1024 * 1024,
  maxReplay: 1000,
  snapshotTurns: 50,
};

interface Sub {
  state: "pending" | "live";
  /** Seq of the last committed push sent in this scope (ephemeral pushes are based on it). */
  sent: number;
}

interface Dirty {
  /** Newest committed row for the entity since the last batch (`null`: ephemeral only). */
  seq: number | null;
  /** Removed sessions: their workspace. */
  workspaceId?: string;
}

interface Queued {
  /** "shell", "session:<id>", or "" (untagged). */
  scope: string;
  data: string;
  /** Snapshots don't count against the budget (they're the fallback). */
  counted: boolean;
}

export class SyncHub {
  readonly options: Resolved;
  private readonly clients = new Set<SyncClient>();
  private timer: NodeJS.Timeout | null = null;
  private readonly offRows: () => void;
  /** During a tick: shell entities read once for every client. */
  private shellMemo: Map<string, ServerMessage | null> | null = null;
  private soon: NodeJS.Timeout | null = null;

  constructor(
    readonly source: SyncSource,
    options: SyncOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.offRows = source.store.onEvents((rows) => this.ingest(rows));
  }

  /** A protocol-2 client (its first `subscribe`). */
  connect(socket: SyncSocket): SyncClient {
    const client = new SyncClient(this, socket);
    this.clients.add(client);
    this.timer ??= setInterval(() => this.tick(), this.options.batchMs);
    this.timer.unref?.();
    return client;
  }

  /** @internal */
  forget(client: SyncClient): void {
    this.clients.delete(client);
    if (!this.clients.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Send every client's pending batch now (tests; the timer does this every `batchMs`). */
  tick(): void {
    if (this.soon) clearTimeout(this.soon);
    this.soon = null;
    this.shellMemo = new Map();
    const now = Date.now();
    try {
      for (const client of [...this.clients]) client.tick(now);
    } finally {
      this.shellMemo = null;
    }
  }

  /** Send soon (a replay or snapshot shouldn't wait for the next batch). */
  flushSoon(): void {
    if (this.soon) return;
    this.soon = setTimeout(() => this.tick(), 0);
    this.soon.unref?.();
  }

  private ingest(rows: EventRow[]): void {
    const patches = new Map<number, { messages: ReturnType<Store["messagesByIds"]>; toolResults: ReturnType<Store["toolResultsByIds"]> }>();
    const patchOf = (row: EventRow) => {
      let patch = patches.get(row.seq);
      if (!patch) {
        const store = this.source.store;
        patch = {
          messages: store.messagesByIds(row.sessionId!, row.payload?.messages ?? []),
          toolResults: store.toolResultsByIds(row.sessionId!, row.payload?.toolResults ?? []),
        };
        patches.set(row.seq, patch);
      }
      return patch;
    };
    for (const client of this.clients) client.ingest(rows, patchOf);
  }

  /** The current push for a shell entity (`null`: nothing to send). */
  materialize(key: string, dirty: Dirty, batch: Map<string, Dirty>): ServerMessage | null {
    const memoKey = `${key}|${dirty.workspaceId ?? ""}`;
    if (this.shellMemo?.has(memoKey)) return this.shellMemo.get(memoKey)!;
    const { store } = this.source;
    const [kind, id = ""] = splitKey(key);
    let message: ServerMessage | null = null;
    if (kind === "project") {
      const project = store.getProject(id);
      message = project ? { type: "project_upsert", project } : { type: "project_removed", projectId: id };
    } else if (kind === "workspace") {
      const summary = store.getWorkspace(id) ? this.source.workspaceSummary(id) : null;
      message = summary ? { type: "workspace_upsert", workspace: summary } : { type: "workspace_removed", workspaceId: id };
    } else if (kind === "session") {
      const summary = store.getSession(id) ? this.source.sessionSummary(id) : null;
      if (summary) message = { type: "session_upsert", session: summary };
      else if (dirty.workspaceId && !(batch.has(`workspace:${dirty.workspaceId}`) && !store.getWorkspace(dirty.workspaceId))) {
        // (Sessions of a workspace removed in the same batch go with its `workspace_removed`.)
        message = { type: "session_removed", sessionId: id, workspaceId: dirty.workspaceId };
      }
    } else if (kind === "settings") {
      message = { type: "settings", settings: store.getSettings() };
    } else if (kind === "environment") {
      const environment = this.source.environmentInfo?.();
      message = environment ? { type: "environment", environment } : null;
    }
    this.shellMemo?.set(memoKey, message);
    return message;
  }

  dispose(): void {
    this.offRows();
    for (const client of [...this.clients]) client.dispose();
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = null;
    this.soon = null;
  }
}

function splitKey(key: string): [string, string?] {
  const i = key.indexOf(":");
  return i === -1 ? [key] : [key.slice(0, i), key.slice(i + 1)];
}

/** One protocol-2 connection: its subscriptions, queue and liveness. */
export class SyncClient {
  private shell: Sub | null = null;
  private readonly sessions = new Map<string, Sub>();
  private dirty = new Map<string, Dirty>();
  private queue: Queued[] = [];
  private queueBytes = 0;
  /** Over budget: everything is re-sent as snapshots once the socket drained. */
  private overflowed = false;
  private lastSeen = Date.now();
  private lastPing = Date.now();
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly hub: SyncHub,
    private readonly socket: SyncSocket,
  ) {
    this.unsubscribe = hub.source.subscribe((m) => this.onBroadcast(m));
  }

  private get store(): Store {
    return this.hub.source.store;
  }

  // Client messages ------------------------------------------------------------------------------

  /** Any message from the client (it's alive). */
  seen(): void {
    this.lastSeen = Date.now();
  }

  ping(t: number): void {
    this.sendNow({ type: "pong", t });
  }

  subscribeShell(afterSeq?: number): void {
    const sub: Sub = { state: "live", sent: 0 };
    this.shell = sub;
    this.dropQueued("shell");
    this.dirty = new Map();
    const { store } = this;
    const { options } = this.hub;
    store.reload();
    const head = store.headSeq;
    const rows = afterSeq === undefined || !this.replayable(afterSeq, head) ? null : store.eventsBetween(afterSeq, head, { scope: "shell" }, options.maxReplay + 1);
    if (!rows || rows.length > options.maxReplay) {
      this.enqueue("shell", { type: "snapshot", scope: "shell", seq: head, shell: this.hub.source.shellSnapshot() }, false);
      this.enqueue("shell", { type: "live", scope: "shell", seq: head, check: this.check() });
      sub.sent = head;
      this.hub.flushSoon();
      return;
    }
    // Replay: every entity the rows name, as it is now; then `live`, then (the list is always
    // checked again) the live status of every busy session, which can change without a row.
    const keys = new Map<string, Dirty>();
    for (const row of rows) this.markRow(keys, row);
    let prev = afterSeq!;
    for (const [key, dirty] of [...keys].filter(([, d]) => d.seq !== null).sort((a, b) => a[1].seq! - b[1].seq!)) {
      const message = this.hub.materialize(key, dirty, keys);
      if (!message) continue;
      this.enqueue("shell", { ...message, seq: dirty.seq!, prev });
      prev = dirty.seq!;
    }
    this.enqueue("shell", { type: "live", scope: "shell", seq: head, check: this.check() });
    sub.sent = head;
    for (const session of this.hub.source.activeSessionSummaries()) this.enqueue("shell", { type: "session_upsert", session, seq: head });
    this.hub.flushSoon();
  }

  async subscribeSession(sessionId: string, afterSeq?: number): Promise<void> {
    const sub: Sub = { state: "pending", sent: 0 };
    this.sessions.set(sessionId, sub);
    this.dropQueued(`session:${sessionId}`);
    let read: () => SessionSyncView;
    try {
      read = await this.hub.source.prepareSession(sessionId);
    } catch (err) {
      if (this.sessions.get(sessionId) !== sub || this.closed) return;
      this.sessions.delete(sessionId);
      this.enqueue("", { type: "subscribe_error", scope: "session", sessionId, error: (err as Error).message });
      this.hub.flushSoon();
      return;
    }
    if (this.sessions.get(sessionId) !== sub || this.closed) return;
    const view = read(); // writes pending changes: the store now equals view.transcript
    const { store } = this;
    store.reload();
    const head = store.headSeq;
    const { maxReplay, snapshotTurns } = this.hub.options;
    const live: SessionLiveState = { state: view.state, pendingUiRequests: view.pendingUiRequests, ...(view.offline ? { offline: true } : {}) };
    const rows = afterSeq === undefined || !this.replayable(afterSeq, head) ? null : store.eventsBetween(afterSeq, head, { sessionId }, maxReplay + 1);
    const scope = `session:${sessionId}`;
    if (!rows || rows.length > maxReplay || rows.some((r) => r.payload?.reset || (!r.payload?.messages && !r.payload?.toolResults))) {
      const page = pageOf(view.transcript, { turns: snapshotTurns });
      this.enqueue(scope, { type: "snapshot", scope: "session", sessionId, seq: head, page, ...live }, false);
    } else if (rows.length) {
      const messages = store.messagesByIds(sessionId, rows.flatMap((r) => r.payload?.messages ?? []));
      const toolResults = store.toolResultsByIds(sessionId, rows.flatMap((r) => r.payload?.toolResults ?? []));
      this.enqueue(scope, { type: "transcript_patch", sessionId, messages, toolResults, seq: rows.at(-1)!.seq, prev: afterSeq! });
    }
    this.enqueue(scope, { type: "live", scope: "session", sessionId, seq: head, ...live });
    sub.state = "live";
    sub.sent = head;
    this.hub.flushSoon();
  }

  unsubscribeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.dropQueued(`session:${sessionId}`);
  }

  /** `afterSeq` can be replayed from the log (not ahead of it, nothing pruned in between). */
  private replayable(afterSeq: number, head: number): boolean {
    if (!Number.isInteger(afterSeq) || afterSeq < 0 || afterSeq > head) return false;
    if (afterSeq === head) return true;
    const oldest = this.store.oldestSeq();
    return oldest !== null && afterSeq >= oldest - 1;
  }

  private check(): { projects: string[]; workspaces: string[]; sessions: string[] } {
    const { store } = this;
    return {
      projects: store.listProjects().map((p) => p.id),
      workspaces: store.listWorkspaces().map((w) => w.id),
      sessions: store.listSessions().map((s) => s.id),
    };
  }

  // App pushes and committed rows ---------------------------------------------------------------

  /** A push the app broadcast (`AppContext.broadcast`). */
  onBroadcast(message: ServerMessage): void {
    if (this.closed || this.overflowed) return;
    switch (message.type) {
      case "session_event": {
        const sub = this.sessions.get(message.sessionId);
        if (sub?.state === "live") this.enqueue(`session:${message.sessionId}`, { ...message, seq: sub.sent });
        else if (message.event.type === "notify") this.enqueue("", message);
        return;
      }
      case "session_upsert":
        return this.markDirty(`session:${message.session.id}`, null, message.session.workspaceId);
      case "session_removed":
        return this.markDirty(`session:${message.sessionId}`, null, message.workspaceId);
      case "workspace_upsert":
        return this.markDirty(`workspace:${message.workspace.id}`, null);
      case "workspace_removed":
        return this.markDirty(`workspace:${message.workspaceId}`, null);
      case "project_upsert":
        return this.markDirty(`project:${message.project.id}`, null);
      case "project_removed":
        return this.markDirty(`project:${message.projectId}`, null);
      case "settings":
        return this.markDirty("settings", null);
      case "environment":
        return this.markDirty("environment", null);
      case "models":
      case "usage_limits":
        if (this.shell?.state === "live") this.enqueue("shell", { ...message, seq: this.shell.sent });
        return;
      case "open_chat":
        this.enqueue("", message);
        return;
      default:
        return;
    }
  }

  /** Committed event-log rows, in seq order. */
  ingest(rows: EventRow[], patchOf: (row: EventRow) => { messages: unknown[]; toolResults: unknown[] }): void {
    if (this.closed || this.overflowed) return;
    for (const row of rows) {
      if (row.scope === "shell") {
        if (this.shell?.state === "live" && row.seq > this.shell.sent) this.markRow(this.dirty, row);
        continue;
      }
      if (row.type !== "messages" || !row.sessionId) continue;
      const sub = this.sessions.get(row.sessionId);
      if (sub?.state !== "live" || row.seq <= sub.sent) continue;
      const scope = `session:${row.sessionId}`;
      if (row.payload?.reset || (!row.payload?.messages && !row.payload?.toolResults)) {
        // Imported/merged (positions may have moved) or an older server's row: start over.
        void this.subscribeSession(row.sessionId);
        continue;
      }
      if (!row.foreign && row.payload.live) {
        this.enqueue(scope, { type: "session_sync", sessionId: row.sessionId, seq: row.seq, prev: sub.sent });
      } else {
        const patch = patchOf(row) as Pick<Extract<ServerMessage, { type: "transcript_patch" }>, "messages" | "toolResults">;
        this.enqueue(scope, { type: "transcript_patch", sessionId: row.sessionId, ...patch, seq: row.seq, prev: sub.sent });
      }
      sub.sent = row.seq;
    }
  }

  /** The shell entities a row touches. */
  private markRow(into: Map<string, Dirty>, row: EventRow): void {
    const id = row.entityId ?? "";
    const set = (key: string, seq: number | null, workspaceId?: string) => {
      const before = into.get(key);
      into.set(key, {
        seq: seq === null ? (before?.seq ?? null) : Math.max(seq, before?.seq ?? 0),
        ...(workspaceId || before?.workspaceId ? { workspaceId: workspaceId ?? before?.workspaceId } : {}),
      });
    };
    switch (row.type) {
      case "project":
        return set(`project:${id}`, row.seq);
      case "workspace":
        return set(`workspace:${id}`, row.seq);
      case "settings":
        return set("settings", row.seq);
      case "environment":
        return set("environment", row.seq);
      case "session": {
        const workspaceId = row.payload?.workspaceId ?? this.store.getSession(id)?.workspaceId;
        set(`session:${id}`, row.seq, workspaceId);
        if (workspaceId) set(`workspace:${workspaceId}`, null); // status roll-up
        return;
      }
      case "agent": {
        // A sub-agent's record shows in its session and its parent's (spawned agents).
        set(`session:${id}`, row.seq);
        const agent = this.store.getAgent(id);
        if (agent) {
          set(`session:${agent.parentSessionId}`, null);
          set(`workspace:${agent.workspaceId}`, null);
        }
        return;
      }
      default:
        return;
    }
  }

  private markDirty(key: string, seq: number | null, workspaceId?: string): void {
    if (this.shell?.state !== "live") return;
    const before = this.dirty.get(key);
    this.dirty.set(key, {
      seq: seq ?? before?.seq ?? null,
      ...(workspaceId || before?.workspaceId ? { workspaceId: workspaceId ?? before?.workspaceId } : {}),
    });
  }

  // Sending ---------------------------------------------------------------------------------------

  private enqueue(scope: string, message: ServerMessage, counted = true): void {
    if (this.closed) return;
    const data = JSON.stringify(message);
    this.queue.push({ scope, data, counted });
    if (counted) this.queueBytes += data.length;
  }

  private dropQueued(scope: string): void {
    this.queue = this.queue.filter((q) => q.scope !== scope);
    this.queueBytes = this.queue.reduce((n, q) => n + (q.counted ? q.data.length : 0), 0);
  }

  private sendNow(message: ServerMessage): void {
    if (this.closed) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      /* closing */
    }
  }

  /** Batch interval: flush the queue and the dirty shell entities; pings and dead sockets. */
  tick(now: number): void {
    if (this.closed) return;
    const { pingMs, deadMs, budgetBytes } = this.hub.options;
    if (now - this.lastSeen > deadMs) {
      this.hub.source.log?.("sync: closing a client that stopped answering pings");
      this.socket.close();
      this.dispose();
      return;
    }
    if (now - this.lastPing >= pingMs) {
      this.lastPing = now;
      this.sendNow({ type: "ping", t: now });
    }
    const buffered = this.socket.bufferedAmount();
    if (this.overflowed) {
      if (buffered > budgetBytes / 4) return;
      this.recover();
    }
    this.flushDirty();
    if (!this.queue.length) return;
    if (buffered + this.queueBytes > budgetBytes) {
      this.overflow();
      if (buffered > budgetBytes / 4) return;
      this.recover();
      this.flushDirty();
    }
    const data = `{"type":"batch","messages":[${this.queue.map((q) => q.data).join(",")}]}`;
    this.queue = [];
    this.queueBytes = 0;
    try {
      this.socket.send(data);
    } catch {
      /* closing */
    }
  }

  /** Dirty shell entities → pushes (committed ones in seq order, then ephemeral ones). */
  private flushDirty(): void {
    const shell = this.shell;
    if (!this.dirty.size || shell?.state !== "live") return;
    const batch = this.dirty;
    this.dirty = new Map();
    const entries = [...batch];
    const committed = entries.filter(([, d]) => d.seq !== null && d.seq > shell.sent).sort((a, b) => a[1].seq! - b[1].seq!);
    const ephemeral = entries.filter(([, d]) => d.seq === null || d.seq <= shell.sent);
    for (const [key, dirty] of committed) {
      const message = this.hub.materialize(key, dirty, batch);
      if (!message) continue;
      this.enqueue("shell", { ...message, seq: dirty.seq!, prev: shell.sent });
      shell.sent = dirty.seq!;
    }
    for (const [key, dirty] of ephemeral) {
      const message = this.hub.materialize(key, dirty, batch);
      if (message) this.enqueue("shell", { ...message, seq: shell.sent });
    }
  }

  /** Too much queued for a slow client: drop it all; snapshots follow once it drained. */
  private overflow(): void {
    this.hub.source.log?.("sync: a client fell behind; sending snapshots instead");
    this.overflowed = true;
    this.queue = [];
    this.queueBytes = 0;
    this.dirty = new Map();
  }

  private recover(): void {
    this.overflowed = false;
    if (this.shell) this.subscribeShell();
    for (const id of [...this.sessions.keys()]) void this.subscribeSession(id);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.queue = [];
    this.sessions.clear();
    this.hub.forget(this);
  }
}
