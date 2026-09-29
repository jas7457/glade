/**
 * Glade's own persistent data (I-121): one SQLite database, `<dataDir>/glade.db`, holding
 * projects, workspaces, sessions, sub-agent records, settings, chat summaries and every
 * conversation in one normalized format (`messages` + `tool_results`), whatever harness ran it.
 * Harness files (pi's JSONL, ACP's old JSON copies) are only import sources; the harness keeps
 * its own session only to resume it (`sessions.resume_json`, `Session.sessionRef`).
 *
 * Records are cached in memory (the app reads them constantly) and written through: every change
 * is one transaction that also appends a row to `events`. Several servers may share the data
 * folder (I-062): `watch()` polls `events` for other servers' rows (`seq > last`), refreshes the
 * records they name from the database and reports them to `onExternalChange` listeners (the
 * AppService pushes them to its clients). Per-record last-writer-wins, like the JSON store was.
 *
 * On first open the JSON files of older versions are imported once (`import-json.ts`) and left
 * untouched; `store/startup.ts` deletes them after the migration is confirmed.
 *
 * Images live in files (`blobs`, I-157): every message/tool result is written with blob
 * references instead of inline base64 (`externalizeImages`), older rows are moved out once
 * (`migrate-images.ts`), and unreferenced blobs are collected (`collectBlobs`).
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deepMerge,
  defaultSettings,
  type ChatMessage,
  type DeepPartial,
  type Project,
  type Session,
  type MessagePatch,
  type Settings,
  type ToolResult,
  type TranscriptPage,
  type Transcript,
  type Workspace,
  toolCallIdsOf,
  turnPageStart,
} from "@glade/protocol";
import type { AgentRecord } from "../services/agents.js";
import type { SessionTextMessage } from "../harness/types.js";
import { DB_FILE, getMeta, getMetaJson, inTransaction, openDatabase, setMeta, setMetaJson, transaction, type Db } from "./db/database.js";
import { ENVIRONMENT_ID_KEY, ensureEnvironmentId } from "./db/migrations/003-environment.js";
import { ulid } from "./db/ids.js";
import { BLOB_GC_GRACE_MS, BlobStore, type BlobGcResult } from "./blobs.js";
import { blobRefsIn, externalizeImages } from "./images.js";
import { migrateInlineImages, type ImageMigrationResult } from "./migrate-images.js";
import { dropRemovedGeneral, migrateSettings, readLegacyData, type LegacyData } from "./import-json.js";
import {
  agentMessageMeta,
  mergeTranscripts,
  messageStatus,
  PAYLOAD_VERSION,
  searchableText,
  settleTranscript,
  type MergeResult,
} from "./transcript-rows.js";

export { migrateSettings } from "./import-json.js";

/** What another server changed (I-062), found by reading the records its events name. */
export interface StoreChange {
  projects: { upserted: Project[]; removed: string[] };
  workspaces: { upserted: Workspace[]; removed: string[] };
  /** Removed sessions are the last known records (callers need their workspace). */
  sessions: { upserted: Session[]; removed: Session[] };
  settings: boolean;
}

/**
 * One row of the event log (I-122), as the sync hub sees it. `type`: "project" | "workspace" |
 * "session" | "agent" | "settings" | "environment" (scope "shell") or "messages" (scope "session").
 */
export interface EventRow {
  seq: number;
  serverId: string;
  /** Written by another server on the data folder. */
  foreign: boolean;
  scope: "shell" | "session";
  sessionId: string | null;
  type: string;
  entityId: string | null;
  payload: EventPayload | null;
}

/** What `payload_json` holds (all optional: rows of schema-1 servers have none). */
export interface EventPayload {
  /** session rows: the session's workspace (for removals). */
  workspaceId?: string;
  /** messages rows written by a live process's TranscriptWriter. */
  messages?: string[];
  toolResults?: string[];
  /** The changes were pushed to clients as `session_event`s already (this server's live stream). */
  live?: boolean;
  /** A harness file was imported or merged and messages moved (clients reload the transcript). */
  reset?: boolean;
  /** Import counts (harness file merges). */
  imported?: number;
  updated?: number;
}

/** A command receipt (I-122): what happened to a request with this `commandId`. */
export type CommandReceipt =
  | { state: "new" }
  | { state: "pending"; serverId: string }
  | { state: "done"; status: number; body: string | null }
  | { state: "conflict"; route: string };

/** Where a stored conversation came from and how current it is (`transcripts` row). */
export interface TranscriptInfo {
  /** "live" (written while it ran here), or the harness / format it was imported from. */
  source: string;
  /** The harness file's signature when last known to be in sync (`null` = unknown). */
  sourceSig: string | null;
  version: number;
  messageCount: number;
}

/** A stored summary of a chat (search, I-048). */
export interface StoredSummary {
  text: string;
  messageCount: number;
  at: number;
}

/** What `meta.json_import` records about the one-time JSON import. */
export interface JsonImportRecord {
  at: number;
  files: string[];
  failed: Array<{ file: string; error: string }>;
  counts: Record<string, number>;
}

export interface StoreOptions {
  /** Id written on this store's events (other servers skip their own). Default: a new ULID. */
  serverId?: string;
  /** How often `watch()` polls `events` (ms). Default 150. */
  pollMs?: number;
  /** Import the older JSON files on first open (default true). */
  importJson?: boolean;
  /** Move inline images of older rows to blobs on open (I-157; default true). */
  migrateImages?: boolean;
  /** How often `watch()` collects unreferenced blobs (ms; default 6 h; 0 = never). */
  blobGcMs?: number;
}

/** Events older than this are pruned (and never needed by other servers after a few seconds). */
const EVENTS_MAX_AGE_MS = 7 * 24 * 3600_000;
const EVENTS_MAX_ROWS = 100_000;

const ENVIRONMENT_NAME_KEY = "environment_name";

type Row = Record<string, unknown>;

export class Store {
  readonly db: Db;
  readonly serverId: string;
  /**
   * This data folder's environment (I-123): permanent, shared by every server on the folder.
   * Every project carries it (`Project.environmentId`), set at creation and never changed.
   */
  readonly environmentId: string;
  /** The JSON import this open performed (null when the database already had one). */
  readonly jsonImport: JsonImportRecord | null = null;
  /** Image files (I-157): `<dataDir>/blobs`. */
  readonly blobs: BlobStore;
  /** What moving inline images out did on this open (null: not run). */
  readonly imageMigration: ImageMigrationResult | null = null;
  private gcTimer: NodeJS.Timeout | null = null;
  private gcSoon: NodeJS.Timeout | null = null;
  private readonly projects = new Map<string, Project>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly sessions = new Map<string, Session>();
  private readonly agents = new Map<string, AgentRecord>();
  private settingsOverrides: DeepPartial<Settings> = {};
  private settingsCache: Settings | null = null;
  private lastSeq = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastPrune = 0;
  private closed = false;
  private readonly changeListeners = new Set<(change: StoreChange) => void>();
  private readonly agentListeners = new Set<(sessionIds: string[]) => void>();
  private readonly rowListeners = new Set<(rows: EventRow[]) => void>();

  constructor(
    readonly dataDir: string,
    /** Unused (the JSON store's write debounce); kept so callers and tests don't change. */
    _debounceMs?: number,
    private readonly options: StoreOptions = {},
  ) {
    this.serverId = options.serverId ?? ulid();
    this.db = openDatabase(join(dataDir, DB_FILE));
    this.blobs = new BlobStore(join(dataDir, "blobs"));
    this.environmentId = getMeta(this.db, ENVIRONMENT_ID_KEY) ?? transaction(this.db, () => ensureEnvironmentId(this.db));
    if (options.importJson !== false) this.jsonImport = this.importJsonOnce();
    this.loadAll();
    if (options.migrateImages !== false) this.imageMigration = this.moveImagesOut();
    this.lastSeq = Number((this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq);
    this.pruneEvents();
    this.writeSettingsExport();
  }

  // Sharing with other servers (I-062) -------------------------------------------------------

  /** Start polling the event log for other servers' changes (and collecting unused blobs). */
  watch(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.reload(), this.options.pollMs ?? 150);
    this.timer.unref();
    const gcMs = this.options.blobGcMs ?? 6 * 3600_000;
    if (gcMs > 0) {
      this.gcTimer = setInterval(() => this.collectBlobsQuietly(), gcMs);
      this.gcTimer.unref();
      this.scheduleBlobGc(10 * 60_000);
    }
  }

  // Image blobs (I-157) -------------------------------------------------------------------------

  private moveImagesOut(): ImageMigrationResult | null {
    try {
      const started = Date.now();
      const result = migrateInlineImages(this.db, this.blobs);
      if (result.ran && result.images) {
        const rows = Object.entries(result.rows)
          .map(([t, n]) => `${n} ${t}`)
          .join(", ");
        console.log(`[glade] store: moved ${result.images} inline images to blobs (${rows} rows, ${Date.now() - started} ms)${result.skipped ? `; ${result.skipped} rows left for the next start` : ""}`);
      }
      return result;
    } catch (err) {
      // Inline images stay readable; the next start tries again.
      console.warn(`[glade] store: moving images to blobs failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Every blob hash a stored row references (events only of sessions that still exist). */
  referencedBlobs(): Set<string> {
    const refs = new Set<string>();
    const like = `%"blob":"sha256:%`;
    for (const sql of [
      "SELECT payload_json AS json FROM messages WHERE payload_json LIKE ?",
      "SELECT payload_json AS json FROM tool_results WHERE payload_json LIKE ?",
      "SELECT payload_json AS json FROM events WHERE payload_json LIKE ? AND (session_id IS NULL OR session_id IN (SELECT id FROM sessions))",
    ]) {
      for (const row of this.db.prepare(sql).iterate(like) as Iterable<{ json: string | null }>) if (row.json) blobRefsIn(row.json, refs);
    }
    return refs;
  }

  /** Delete blobs nothing references any more (older than the grace period). */
  collectBlobs({ graceMs = BLOB_GC_GRACE_MS }: { graceMs?: number } = {}): BlobGcResult {
    return this.blobs.gc(this.referencedBlobs(), { graceMs });
  }

  private collectBlobsQuietly(): void {
    if (this.closed) return;
    try {
      const r = this.collectBlobs();
      if (r.deleted) console.log(`[glade] store: removed ${r.deleted} unused image blobs (${Math.round(r.bytesFreed / 1024)} KB)`);
    } catch (err) {
      console.warn(`[glade] store: blob cleanup failed: ${(err as Error).message}`);
    }
  }

  /** Collect blobs in `delayMs` (debounced: a chat deletion, possibly on another server). */
  scheduleBlobGc(delayMs = 60_000): void {
    if (this.closed || this.gcSoon || (this.options.blobGcMs ?? 1) === 0) return;
    this.gcSoon = setTimeout(() => {
      this.gcSoon = null;
      this.collectBlobsQuietly();
    }, delayMs);
    this.gcSoon.unref();
  }

  /** Read other servers' new events now (tests; the poll does this on its own). */
  reload(): void {
    if (this.closed) return;
    // A listener that writes (e.g. marking a session read) reads again after this round, so every
    // `onEvents` listener gets the rows in seq order.
    if (this.reloading) {
      this.reloadAgain = true;
      return;
    }
    this.reloading = true;
    try {
      do {
        this.reloadAgain = false;
        this.readEvents();
      } while (this.reloadAgain && !this.closed);
    } finally {
      this.reloading = false;
    }
  }

  private reloading = false;
  private reloadAgain = false;

  private readEvents(): void {
    let rows: Row[];
    try {
      rows = this.db.prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq").all(this.lastSeq) as Row[];
    } catch (err) {
      console.warn(`[glade] could not read the event log: ${(err as Error).message}`);
      return;
    }
    if (!rows.length) return;
    this.lastSeq = Number(rows.at(-1)!.seq);
    const events = rows.map((row) => this.toEventRow(row));
    const touched = new Map<string, Set<string>>();
    for (const row of events) {
      if (!row.foreign) continue;
      // A removed session's workspace, from our copy while we still have it (older rows lack it).
      if (row.type === "session" && row.entityId && !row.payload?.workspaceId) {
        const known = this.sessions.get(row.entityId);
        if (known) row.payload = { ...row.payload, workspaceId: known.workspaceId };
      }
      let ids = touched.get(row.type);
      if (!ids) touched.set(row.type, (ids = new Set()));
      ids.add(row.entityId ?? "");
    }
    const notify = touched.size ? this.applyForeign(touched) : null;
    // A chat deleted here or elsewhere may have left images nothing references (I-157).
    if (events.some((r) => r.type === "session" && r.entityId && !this.sessions.has(r.entityId))) this.scheduleBlobGc();
    for (const listener of this.rowListeners) {
      try {
        listener(events);
      } catch (err) {
        console.warn(`[glade] event listener failed: ${(err as Error).message}`);
      }
    }
    notify?.();
    if (Date.now() - this.lastPrune > 3600_000) this.pruneEvents();
  }

  /**
   * Every event-log row, in seq order, once it's committed (I-122): this server's rows right after
   * the write, other servers' rows when the poll finds them. Caches are current when it's called.
   */
  onEvents(listener: (rows: EventRow[]) => void): () => void {
    this.rowListeners.add(listener);
    return () => this.rowListeners.delete(listener);
  }

  /** The last event-log seq this store has read (and told `onEvents` listeners about). */
  get headSeq(): number {
    return this.lastSeq;
  }

  /** After a local write: read the log up to its end (our rows, and other servers' before them). */
  private publish(): void {
    if (this.closed || inTransaction(this.db)) return;
    this.reload();
  }

  private toEventRow(row: Row): EventRow {
    let payload: EventPayload | null = null;
    if (typeof row.payload_json === "string") {
      try {
        payload = JSON.parse(row.payload_json) as EventPayload;
      } catch {
        payload = null;
      }
    }
    return {
      seq: Number(row.seq),
      serverId: String(row.server_id),
      foreign: row.server_id !== this.serverId,
      scope: row.scope === "session" ? "session" : "shell",
      sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
      type: String(row.type),
      entityId: row.entity_id === null || row.entity_id === undefined ? null : String(row.entity_id),
      payload,
    };
  }

  // Replay (I-122) -----------------------------------------------------------------------------

  /** The oldest seq still in the log (pruning removes older ones); `null` when it's empty. */
  oldestSeq(): number | null {
    const row = this.db.prepare("SELECT MIN(seq) AS seq FROM events").get() as { seq: number | null };
    return row.seq === null ? null : Number(row.seq);
  }

  /** Rows of one scope (or one session's) in `(afterSeq, toSeq]`, oldest first. */
  eventsBetween(afterSeq: number, toSeq: number, filter: { scope: "shell" } | { sessionId: string }, limit = 100_000): EventRow[] {
    const rows =
      "scope" in filter
        ? this.db.prepare("SELECT * FROM events WHERE seq > ? AND seq <= ? AND scope = ? ORDER BY seq LIMIT ?").all(afterSeq, toSeq, filter.scope, limit)
        : this.db
            .prepare("SELECT * FROM events WHERE session_id = ? AND seq > ? AND seq <= ? AND scope = 'session' ORDER BY seq LIMIT ?")
            .all(filter.sessionId, afterSeq, toSeq, limit);
    return (rows as Row[]).map((r) => this.toEventRow(r));
  }

  /** Stored messages with these ids and their positions (for patches). */
  messagesByIds(sessionId: string, ids: Iterable<string>): MessagePatch[] {
    const out: MessagePatch[] = [];
    const stmt = this.db.prepare("SELECT seq, payload_json FROM messages WHERE session_id = ? AND id = ?");
    for (const id of new Set(ids)) {
      const row = stmt.get(sessionId, id) as { seq: number; payload_json: string } | undefined;
      if (row) out.push({ index: Number(row.seq), message: JSON.parse(row.payload_json) as ChatMessage });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  toolResultsByIds(sessionId: string, ids: Iterable<string>): ToolResult[] {
    const out: ToolResult[] = [];
    const stmt = this.db.prepare("SELECT payload_json FROM tool_results WHERE session_id = ? AND tool_call_id = ?");
    for (const id of new Set(ids)) {
      const row = stmt.get(sessionId, id) as { payload_json: string } | undefined;
      if (row) out.push(JSON.parse(row.payload_json) as ToolResult);
    }
    return out;
  }

  // Command receipts (I-122) ------------------------------------------------------------------

  /** Claim `commandId` for `route`, or learn what happened to it. */
  beginCommand(commandId: string, route: string): CommandReceipt {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT route, server_id, status, response_json FROM command_receipts WHERE command_id = ?").get(commandId) as Row | undefined;
      if (row) {
        if (row.route !== route) return { state: "conflict", route: String(row.route) };
        if (row.status === null) return { state: "pending", serverId: String(row.server_id) };
        return { state: "done", status: Number(row.status), body: row.response_json === null ? null : String(row.response_json) };
      }
      const now = Date.now();
      this.db.prepare("DELETE FROM command_receipts WHERE created_at < ?").run(now - COMMAND_RECEIPT_TTL_MS);
      this.db.prepare("INSERT INTO command_receipts (command_id, route, server_id, created_at) VALUES (?, ?, ?, ?)").run(commandId, route, this.serverId, now);
      return { state: "new" };
    });
  }

  /** The command finished: remember its response (a retry gets the same answer). */
  finishCommand(commandId: string, status: number, body: string | null): void {
    this.db.prepare("UPDATE command_receipts SET status = ?, response_json = ?, done_at = ? WHERE command_id = ?").run(status, body, Date.now(), commandId);
  }

  /** The command failed before it changed anything: forget it (a retry runs it again). */
  dropCommand(commandId: string): void {
    this.db.prepare("DELETE FROM command_receipts WHERE command_id = ? AND status IS NULL").run(commandId);
  }

  onExternalChange(listener: (change: StoreChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Sub-agent records another server added, changed or removed (session ids). */
  onExternalAgentChange(listener: (sessionIds: string[]) => void): () => void {
    this.agentListeners.add(listener);
    return () => this.agentListeners.delete(listener);
  }

  /** Update our copies of what other servers changed; returns the call that tells the listeners. */
  private applyForeign(touched: Map<string, Set<string>>): () => void {
    const change: StoreChange = {
      projects: { upserted: [], removed: [] },
      workspaces: { upserted: [], removed: [] },
      sessions: { upserted: [], removed: [] },
      settings: false,
    };
    for (const id of touched.get("project") ?? []) {
      const next = this.readRecord<Project>("projects", id);
      const before = this.projects.get(id);
      if (next) {
        if (JSON.stringify(before) !== JSON.stringify(next)) change.projects.upserted.push(next);
        this.projects.set(id, next);
      } else if (before) {
        this.projects.delete(id);
        change.projects.removed.push(id);
      }
    }
    for (const id of touched.get("workspace") ?? []) {
      const next = this.readRecord<Workspace>("workspaces", id);
      const before = this.workspaces.get(id);
      if (next) {
        if (JSON.stringify(before) !== JSON.stringify(next)) change.workspaces.upserted.push(next);
        this.workspaces.set(id, next);
      } else if (before) {
        this.workspaces.delete(id);
        change.workspaces.removed.push(id);
      }
    }
    for (const id of touched.get("session") ?? []) {
      const next = this.readRecord<Session>("sessions", id);
      const before = this.sessions.get(id);
      if (next) {
        if (JSON.stringify(before) !== JSON.stringify(next)) change.sessions.upserted.push(next);
        this.sessions.set(id, next);
      } else if (before) {
        this.sessions.delete(id);
        change.sessions.removed.push(before);
      }
    }
    // A workspace removed there took its sessions along.
    for (const wid of change.workspaces.removed) {
      for (const s of [...this.sessions.values()]) {
        if (s.workspaceId !== wid) continue;
        this.sessions.delete(s.id);
        change.sessions.removed.push(s);
      }
    }
    if (touched.has("settings")) {
      const before = JSON.stringify(this.settingsOverrides);
      this.loadSettings();
      change.settings = before !== JSON.stringify(this.settingsOverrides);
    }
    const agentIds: string[] = [];
    for (const id of touched.get("agent") ?? []) {
      const next = this.readRecord<AgentRecord>("agents", id, "session_id");
      const before = this.agents.get(id);
      if (next) {
        if (JSON.stringify(before) !== JSON.stringify(next)) agentIds.push(id);
        this.agents.set(id, next);
      } else if (before) {
        this.agents.delete(id);
        agentIds.push(id);
      }
    }
    const any =
      change.projects.upserted.length ||
      change.projects.removed.length ||
      change.workspaces.upserted.length ||
      change.workspaces.removed.length ||
      change.sessions.upserted.length ||
      change.sessions.removed.length ||
      change.settings;
    return () => {
      if (any) {
        for (const listener of this.changeListeners) {
          try {
            listener(change);
          } catch (err) {
            console.warn(`[glade] store change listener failed: ${(err as Error).message}`);
          }
        }
      }
      if (agentIds.length) for (const listener of this.agentListeners) listener(agentIds);
    };
  }

  private readRecord<T>(table: string, id: string, key = "id"): T | undefined {
    const row = this.db.prepare(`SELECT data_json FROM ${table} WHERE ${key} = ?`).get(id) as { data_json: string } | undefined;
    if (!row) return undefined;
    const record = JSON.parse(row.data_json) as T;
    return table === "projects" ? (this.withEnvironment(record as Project) as T) : record;
  }

  /** A project with its environment (rows an older server wrote after migration 3 lack it). */
  private withEnvironment(p: Project): Project {
    return p.environmentId ? p : { ...p, environmentId: this.environmentId };
  }

  /** Append to the event log (inside the caller's transaction). */
  private event(type: string, entityId: string | null, opts: { scope?: "shell" | "session"; sessionId?: string | null; payload?: unknown } = {}): void {
    this.db
      .prepare("INSERT INTO events (at, server_id, scope, session_id, type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        Date.now(),
        this.serverId,
        opts.scope ?? "shell",
        opts.sessionId ?? null,
        type,
        entityId,
        opts.payload === undefined ? null : JSON.stringify(opts.payload),
      );
  }

  private pruneEvents(): void {
    this.lastPrune = Date.now();
    try {
      this.db.prepare("DELETE FROM events WHERE at < ?").run(Date.now() - EVENTS_MAX_AGE_MS);
      this.db.prepare("DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?").run(EVENTS_MAX_ROWS);
    } catch {
      /* busy: next time */
    }
  }

  // Loading -----------------------------------------------------------------------------------

  private loadAll(): void {
    const all = <T>(sql: string) => (this.db.prepare(sql).all() as Array<{ data_json: string }>).map((r) => JSON.parse(r.data_json) as T);
    for (const p of all<Project>("SELECT data_json FROM projects ORDER BY rowid")) this.projects.set(p.id, this.withEnvironment(p));
    for (const w of all<Workspace>("SELECT data_json FROM workspaces ORDER BY rowid")) this.workspaces.set(w.id, w);
    for (const s of all<Session>("SELECT data_json FROM sessions ORDER BY rowid")) this.sessions.set(s.id, s);
    for (const a of all<AgentRecord>("SELECT data_json FROM agents ORDER BY rowid")) this.agents.set(a.sessionId, a);
    this.loadSettings();
  }

  private loadSettings(): void {
    const row = this.db.prepare("SELECT data_json FROM settings WHERE id = 1").get() as { data_json: string } | undefined;
    this.settingsOverrides = row ? (JSON.parse(row.data_json) as DeepPartial<Settings>) : {};
    this.settingsCache = null;
  }

  /**
   * The one-time import of the JSON files (I-121). Runs in one transaction, only while
   * `meta.json_import` is missing (another server may have done it meanwhile).
   */
  private importJsonOnce(): JsonImportRecord | null {
    if (getMeta(this.db, "json_import") !== null) return null;
    const legacy = readLegacyData(this.dataDir);
    return transaction(this.db, () => {
      if (getMeta(this.db, "json_import") !== null) return null;
      const record = this.writeLegacy(legacy);
      setMetaJson(this.db, "json_import", record);
      return record;
    });
  }

  private writeLegacy(legacy: LegacyData): JsonImportRecord {
    const now = Date.now();
    for (const p of legacy.projects) this.putProject(p, now);
    for (const w of legacy.workspaces) this.putWorkspace(w, now);
    for (const s of legacy.sessions) this.putSession(s, now);
    if (legacy.settings) this.putSettings(legacy.settings, now);
    for (const a of legacy.agents) this.putAgent(a, now);
    for (const [id, s] of Object.entries(legacy.summaries.entries)) {
      this.db.prepare("INSERT OR REPLACE INTO session_summaries (session_id, text, message_count, at) VALUES (?, ?, ?, ?)").run(id, s.text, s.messageCount, s.at);
    }
    if (legacy.summaries.enabledAt !== null) setMetaJson(this.db, "summaries_enabled_at", legacy.summaries.enabledAt);
    let acpTranscripts = 0;
    for (const acp of legacy.acp) {
      const row = this.db.prepare("SELECT id FROM sessions WHERE session_ref = ?").get(acp.ref) as { id: string } | undefined;
      if (!row) continue;
      this.db.prepare("UPDATE sessions SET resume_json = ? WHERE id = ?").run(JSON.stringify({ acpSessionId: acp.acpSessionId, title: acp.title }), row.id);
      this.importTranscriptRows(row.id, acp.transcript, { source: "acp-json", sig: null });
      acpTranscripts++;
    }
    return {
      at: now,
      files: legacy.files,
      failed: legacy.failed,
      counts: {
        projects: legacy.projects.length,
        workspaces: legacy.workspaces.length,
        sessions: legacy.sessions.length,
        agents: legacy.agents.length,
        summaries: Object.keys(legacy.summaries.entries).length,
        acpTranscripts,
      },
    };
  }

  // Row writers (callers hold a transaction) ---------------------------------------------------

  private putProject(project: Project, now: number): void {
    const p = this.withEnvironment(project);
    this.db
      .prepare(
        `INSERT INTO projects (id, environment_id, sort_order, data_json, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET environment_id = excluded.environment_id, sort_order = excluded.sort_order,
           data_json = excluded.data_json, updated_at = excluded.updated_at`,
      )
      .run(p.id, p.environmentId!, p.sortOrder ?? 0, JSON.stringify(p), now);
  }

  private putWorkspace(w: Workspace, now: number): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, project_id, data_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET project_id = excluded.project_id, data_json = excluded.data_json, updated_at = excluded.updated_at`,
      )
      .run(w.id, w.projectId, JSON.stringify(w), now);
  }

  private putSession(s: Session, now: number): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, workspace_id, kind, harness, session_ref, data_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET workspace_id = excluded.workspace_id, kind = excluded.kind, harness = excluded.harness,
           session_ref = excluded.session_ref, data_json = excluded.data_json, updated_at = excluded.updated_at`,
      )
      .run(s.id, s.workspaceId, s.kind, s.harness, s.sessionRef, JSON.stringify(s), now);
  }

  private putAgent(a: AgentRecord, now: number): void {
    this.db
      .prepare(
        `INSERT INTO agents (session_id, parent_session_id, workspace_id, data_json, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET parent_session_id = excluded.parent_session_id, workspace_id = excluded.workspace_id,
           data_json = excluded.data_json, updated_at = excluded.updated_at`,
      )
      .run(a.sessionId, a.parentSessionId, a.workspaceId, JSON.stringify(a), now);
  }

  private putSettings(overrides: DeepPartial<Settings>, now: number): void {
    this.db
      .prepare("INSERT INTO settings (id, data_json, updated_at) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at")
      .run(JSON.stringify(overrides), now);
  }

  private deleteSessionRows(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM tool_results WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM transcripts WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(id);
  }

  // Projects ----------------------------------------------------------------------------------

  listProjects(): Project[] {
    return [...this.projects.values()];
  }

  getProject(id: string): Project | undefined {
    return this.projects.get(id);
  }

  /**
   * Add or replace a project. Its `environmentId` can't change (I-123): a known project keeps
   * its own, a new one gets the given id or this environment's.
   */
  upsertProject(next: Project): Project {
    const environmentId = this.projects.get(next.id)?.environmentId ?? next.environmentId ?? this.environmentId;
    const project: Project = { ...next, environmentId };
    transaction(this.db, () => {
      this.putProject(project, Date.now());
      this.event("project", project.id);
    });
    this.projects.set(project.id, project);
    this.publish();
    return project;
  }

  removeProject(id: string): void {
    transaction(this.db, () => {
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      this.event("project", id);
    });
    this.projects.delete(id);
    this.publish();
  }

  // Environment (I-123) ------------------------------------------------------------------------

  /** The environment's display name, `null` when never set (the machine name is used then). */
  getEnvironmentName(): string | null {
    return getMeta(this.db, ENVIRONMENT_NAME_KEY);
  }

  /** Rename the environment (`null` = back to the machine name); an "environment" event row. */
  setEnvironmentName(name: string | null): void {
    transaction(this.db, () => {
      if (name === null) this.db.prepare("DELETE FROM meta WHERE key = ?").run(ENVIRONMENT_NAME_KEY);
      else setMeta(this.db, ENVIRONMENT_NAME_KEY, name);
      this.event("environment", this.environmentId);
    });
    this.publish();
  }

  // Workspaces ---------------------------------------------------------------------------------

  listWorkspaces(): Workspace[] {
    return [...this.workspaces.values()];
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  upsertWorkspace(workspace: Workspace): Workspace {
    transaction(this.db, () => {
      this.putWorkspace(workspace, Date.now());
      this.event("workspace", workspace.id);
    });
    this.workspaces.set(workspace.id, workspace);
    this.publish();
    return workspace;
  }

  /** Removes the workspace and all of its sessions (with their conversations). */
  removeWorkspace(id: string): void {
    const doomed = [...this.sessions.values()].filter((s) => s.workspaceId === id);
    transaction(this.db, () => {
      const rows = this.db.prepare("SELECT id FROM sessions WHERE workspace_id = ?").all(id) as Array<{ id: string }>;
      for (const sid of new Set([...doomed.map((s) => s.id), ...rows.map((r) => r.id)])) {
        this.deleteSessionRows(sid);
        this.event("session", sid, { payload: { workspaceId: id } });
      }
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      this.event("workspace", id);
    });
    this.workspaces.delete(id);
    for (const s of doomed) this.sessions.delete(s.id);
    this.publish();
  }

  // Sessions -----------------------------------------------------------------------------------

  /** All sessions, or those of one workspace. */
  listSessions(workspaceId?: string): Session[] {
    const all = [...this.sessions.values()];
    return workspaceId === undefined ? all : all.filter((s) => s.workspaceId === workspaceId);
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  upsertSession(session: Session): Session {
    transaction(this.db, () => {
      this.putSession(session, Date.now());
      this.event("session", session.id, { payload: { workspaceId: session.workspaceId } });
    });
    this.sessions.set(session.id, session);
    this.publish();
    return session;
  }

  /** Removes the session and its conversation. */
  removeSession(id: string): void {
    const workspaceId = this.sessions.get(id)?.workspaceId;
    transaction(this.db, () => {
      this.deleteSessionRows(id);
      this.event("session", id, workspaceId ? { payload: { workspaceId } } : {});
    });
    this.sessions.delete(id);
    this.publish();
  }

  /** The adapter's resume cursor (`sessions.resume_json`), opaque to Glade. */
  getResume<T = Record<string, unknown>>(sessionId: string): T | null {
    const row = this.db.prepare("SELECT resume_json FROM sessions WHERE id = ?").get(sessionId) as { resume_json: string | null } | undefined;
    return row?.resume_json ? (JSON.parse(row.resume_json) as T) : null;
  }

  /** Resume cursor of the session whose `sessionRef` is `ref` (harnesses know only their refs). */
  getResumeByRef<T = Record<string, unknown>>(ref: string): T | null {
    const row = this.db.prepare("SELECT resume_json FROM sessions WHERE session_ref = ?").get(ref) as { resume_json: string | null } | undefined;
    return row?.resume_json ? (JSON.parse(row.resume_json) as T) : null;
  }

  /** Merge `patch` into the resume cursor of the session with `sessionRef` = `ref`. False if none. */
  patchResumeByRef(ref: string, patch: Record<string, unknown>): boolean {
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT id, resume_json FROM sessions WHERE session_ref = ?").get(ref) as { id: string; resume_json: string | null } | undefined;
      if (!row) return false;
      const next = { ...(row.resume_json ? (JSON.parse(row.resume_json) as Record<string, unknown>) : {}), ...patch };
      this.db.prepare("UPDATE sessions SET resume_json = ? WHERE id = ?").run(JSON.stringify(next), row.id);
      return true;
    });
  }

  // Sub-agent records (I-037) -------------------------------------------------------------------

  listAgents(): AgentRecord[] {
    return [...this.agents.values()];
  }

  getAgent(sessionId: string): AgentRecord | undefined {
    return this.agents.get(sessionId);
  }

  upsertAgent(record: AgentRecord): AgentRecord {
    transaction(this.db, () => {
      this.putAgent(record, Date.now());
      this.event("agent", record.sessionId);
    });
    this.agents.set(record.sessionId, record);
    this.publish();
    return record;
  }

  /** Patch a record on the database's current copy (fields another server changed survive). */
  patchAgent(sessionId: string, patch: Partial<AgentRecord>): AgentRecord | undefined {
    const next = transaction(this.db, () => {
      const current = this.readRecord<AgentRecord>("agents", sessionId, "session_id") ?? this.agents.get(sessionId);
      if (!current) return undefined;
      const merged = { ...current, ...patch };
      this.putAgent(merged, Date.now());
      this.event("agent", sessionId);
      return merged;
    });
    if (next) this.agents.set(sessionId, next);
    this.publish();
    return next;
  }

  removeAgents(sessionIds: readonly string[]): void {
    if (!sessionIds.length) return;
    transaction(this.db, () => {
      for (const id of sessionIds) {
        this.db.prepare("DELETE FROM agents WHERE session_id = ?").run(id);
        this.event("agent", id);
      }
    });
    for (const id of sessionIds) this.agents.delete(id);
    this.publish();
  }

  // Settings ----------------------------------------------------------------------------------

  /** Effective settings (defaults merged with the stored overrides). */
  getSettings(): Settings {
    this.settingsCache ??= deepMerge(defaultSettings(), migrateSettings(this.settingsOverrides));
    return this.settingsCache;
  }

  /** The stored overrides only (the JSON export). */
  getSettingsOverrides(): DeepPartial<Settings> {
    return this.settingsOverrides;
  }

  updateSettings(patch: DeepPartial<Settings>): Settings {
    const next = transaction(this.db, () => {
      const row = this.db.prepare("SELECT data_json FROM settings WHERE id = 1").get() as { data_json: string } | undefined;
      const current = row ? (JSON.parse(row.data_json) as DeepPartial<Settings>) : {};
      // Removed settings (e.g. I-153's `sendKey`, also from an older client's patch) are dropped on write.
      const merged = dropRemovedGeneral(deepMerge(current as Settings, patch) as DeepPartial<Settings>);
      this.putSettings(merged, Date.now());
      this.event("settings", null);
      return merged;
    });
    this.settingsOverrides = next;
    this.settingsCache = null;
    this.writeSettingsExport();
    this.publish();
    return this.getSettings();
  }

  /**
   * `<dataDir>/settings.export.json`: the stored overrides as JSON, for readers outside the
   * server (the desktop app looks up the pi path there before the server starts). Never read back.
   */
  private writeSettingsExport(): void {
    try {
      const path = join(this.dataDir, SETTINGS_EXPORT_FILE);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(this.settingsOverrides, null, 2)}\n`);
      renameSync(tmp, path);
    } catch {
      /* data folder gone (tests); not essential */
    }
  }

  // Conversations -------------------------------------------------------------------------------

  transcriptInfo(sessionId: string): TranscriptInfo | null {
    const row = this.db.prepare("SELECT source, source_sig, version, message_count FROM transcripts WHERE session_id = ?").get(sessionId) as Row | undefined;
    if (!row) return null;
    return {
      source: String(row.source),
      sourceSig: row.source_sig === null ? null : String(row.source_sig),
      version: Number(row.version),
      messageCount: Number(row.message_count),
    };
  }

  /** Whether the store holds this session's conversation (live-written or imported). */
  hasTranscript(sessionId: string): boolean {
    return this.db.prepare("SELECT 1 FROM transcripts WHERE session_id = ?").get(sessionId) !== undefined;
  }

  /** The stored conversation (`settle`: nothing can still be streaming, for sessions no process runs). */
  loadTranscript(sessionId: string, { settle = false } = {}): Transcript {
    const messages = (this.db.prepare("SELECT payload_json FROM messages WHERE session_id = ? ORDER BY seq, rowid").all(sessionId) as Array<{ payload_json: string }>).map(
      (r) => JSON.parse(r.payload_json) as ChatMessage,
    );
    const toolResults: Record<string, ToolResult> = {};
    for (const r of this.db.prepare("SELECT payload_json FROM tool_results WHERE session_id = ? ORDER BY rowid").all(sessionId) as Array<{ payload_json: string }>) {
      const result = JSON.parse(r.payload_json) as ToolResult;
      toolResults[result.toolCallId] = result;
    }
    const transcript = { messages, toolResults };
    return settle ? settleTranscript(transcript) : transcript;
  }

  /**
   * The newest `turns` turns of a stored conversation before message index `before` (default: the
   * end), with their tool results (I-122 snapshots and "load earlier").
   */
  transcriptPage(sessionId: string, { before, turns, settle = false }: { before?: number; turns: number; settle?: boolean }): TranscriptPage {
    return pageOf(this.loadTranscript(sessionId, { settle }), { before, turns });
  }

  /**
   * Write changed messages (at their position `seq`) and tool results of a live session, in one
   * transaction with one `messages` event. Creates the `transcripts` row (source "live") if needed.
   * `pushed`: every change was already pushed to clients as `session_event`s (I-122).
   */
  saveTranscriptChanges(
    sessionId: string,
    messages: ReadonlyArray<{ message: ChatMessage; seq: number }>,
    toolResults: readonly ToolResult[],
    { pushed = false }: { pushed?: boolean } = {},
  ): void {
    if (!messages.length && !toolResults.length) return;
    transaction(this.db, () => {
      const now = Date.now();
      const to = this.agentNameOf(sessionId);
      for (const { message, seq } of messages) this.putMessage(sessionId, seq, message, to, now);
      for (const r of toolResults) this.putToolResult(sessionId, r, now);
      this.bumpTranscript(sessionId, "live", now);
      this.event("messages", sessionId, {
        scope: "session",
        sessionId,
        payload: { messages: messages.map((m) => m.message.id), toolResults: toolResults.map((r) => r.toolCallId), ...(pushed ? { live: true } : {}) },
      });
    });
    this.publish();
  }

  /**
   * Merge a harness's view of a conversation (e.g. pi's JSONL) into the store: messages the store
   * lacks get new ids, stored ones keep theirs (`mergeTranscripts`). `sig` = the source's
   * signature, recorded as in sync. Returns the merged transcript.
   */
  importTranscript(sessionId: string, imported: Transcript, { source, sig }: { source: string; sig: string | null }): MergeResult {
    const result = transaction(this.db, () => this.importTranscriptRows(sessionId, imported, { source, sig }));
    this.publish();
    return result;
  }

  private importTranscriptRows(sessionId: string, importedRaw: Transcript, { source, sig }: { source: string; sig: string | null }): MergeResult {
    const now = Date.now();
    // Images to blobs first (I-157), so the merged transcript callers keep has references too.
    const imported = externalizeImages(importedRaw, this.blobs);
    const stored = this.loadTranscript(sessionId);
    const storedIds = new Map(stored.messages.map((m, i) => [m.id, { index: i, message: m }]));
    const result = mergeTranscripts(stored, settleTranscript(imported), (m) => ulid(m.timestamp > 0 ? m.timestamp : now));
    const to = this.agentNameOf(sessionId);
    const changed: string[] = [];
    const changedTools: string[] = [];
    let moved = false;
    result.transcript.messages.forEach((m, seq) => {
      const before = storedIds.get(m.id);
      if (before && before.message === m && before.index === seq) return;
      changed.push(m.id);
      if (before && before.index !== seq) moved = true;
      if (before && before.message === m) this.db.prepare("UPDATE messages SET seq = ? WHERE id = ?").run(seq, m.id);
      else this.putMessage(sessionId, seq, m, to, now);
    });
    for (const [id, r] of Object.entries(result.transcript.toolResults)) {
      if (stored.toolResults[id] === r) continue;
      changedTools.push(id);
      this.putToolResult(sessionId, r, now);
    }
    const existing = this.transcriptInfo(sessionId);
    this.db
      .prepare(
        `INSERT INTO transcripts (session_id, source, source_sig, version, message_count, imported_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET source_sig = excluded.source_sig, version = transcripts.version + 1,
           message_count = excluded.message_count, imported_at = excluded.imported_at, updated_at = excluded.updated_at`,
      )
      .run(sessionId, existing?.source ?? source, sig, result.transcript.messages.length, now, now);
    if (result.added || result.updated) {
      // Messages only added at the end or changed in place can be sent as a patch; anything that
      // moved (turns merged in between) makes clients reload the transcript (I-122).
      this.event("messages", sessionId, {
        scope: "session",
        sessionId,
        payload: { imported: result.added, updated: result.updated, messages: changed, toolResults: changedTools, ...(moved ? { reset: true } : {}) },
      });
    }
    return result;
  }

  /** Record the harness file's signature as in sync with the store (after a run / close here). */
  setTranscriptSig(sessionId: string, sig: string | null): void {
    this.db.prepare("UPDATE transcripts SET source_sig = ? WHERE session_id = ?").run(sig, sessionId);
  }

  /** User/assistant text of a stored conversation, in order (search, titles, chat tools). */
  sessionText(sessionId: string): SessionTextMessage[] {
    return (
      this.db
        .prepare("SELECT role, text, created_at FROM messages WHERE session_id = ? AND text IS NOT NULL ORDER BY seq, rowid")
        .all(sessionId) as Array<{ role: string; text: string; created_at: number }>
    ).map((r) => ({ role: r.role as SessionTextMessage["role"], text: r.text, timestamp: Number(r.created_at) }));
  }

  /** sessionId -> transcript version, for every stored conversation (search freshness). */
  transcriptVersions(): Map<string, number> {
    const rows = this.db.prepare("SELECT session_id, version FROM transcripts").all() as Array<{ session_id: string; version: number }>;
    return new Map(rows.map((r) => [r.session_id, Number(r.version)]));
  }

  private agentNameOf(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    return session?.kind === "subagent" && session.agentName ? session.agentName : "main";
  }

  private putMessage(sessionId: string, seq: number, m: ChatMessage, to: string, now: number): void {
    const meta = agentMessageMeta(m, to);
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, role, kind, meta_json, text, created_at, updated_at, status, payload_version, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, role = excluded.role, kind = excluded.kind, meta_json = excluded.meta_json,
           text = excluded.text, updated_at = excluded.updated_at, status = excluded.status,
           payload_version = excluded.payload_version, payload_json = excluded.payload_json`,
      )
      .run(
        m.id,
        sessionId,
        seq,
        m.role,
        meta ? "agent_message" : null,
        meta ? JSON.stringify(meta) : null,
        searchableText(m),
        Number.isFinite(m.timestamp) ? m.timestamp : now,
        now,
        messageStatus(m),
        PAYLOAD_VERSION,
        JSON.stringify(externalizeImages(m, this.blobs)),
      );
  }

  private putToolResult(sessionId: string, r: ToolResult, now: number): void {
    this.db
      .prepare(
        `INSERT INTO tool_results (session_id, tool_call_id, status, updated_at, payload_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_id, tool_call_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, payload_json = excluded.payload_json`,
      )
      .run(sessionId, r.toolCallId, r.status, now, JSON.stringify(externalizeImages(r, this.blobs)));
  }

  private bumpTranscript(sessionId: string, source: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO transcripts (session_id, source, version, message_count, updated_at)
           VALUES (?, ?, 1, (SELECT COUNT(*) FROM messages WHERE session_id = ?), ?)
         ON CONFLICT (session_id) DO UPDATE SET version = transcripts.version + 1,
           message_count = (SELECT COUNT(*) FROM messages WHERE session_id = excluded.session_id), updated_at = excluded.updated_at`,
      )
      .run(sessionId, source, sessionId, now);
  }

  // Chat summaries (search, I-048) ----------------------------------------------------------------

  getSummary(sessionId: string): StoredSummary | null {
    const row = this.db.prepare("SELECT text, message_count, at FROM session_summaries WHERE session_id = ?").get(sessionId) as Row | undefined;
    return row ? { text: String(row.text), messageCount: Number(row.message_count), at: Number(row.at) } : null;
  }

  listSummaries(): Map<string, StoredSummary> {
    const rows = this.db.prepare("SELECT session_id, text, message_count, at FROM session_summaries").all() as Row[];
    return new Map(rows.map((r) => [String(r.session_id), { text: String(r.text), messageCount: Number(r.message_count), at: Number(r.at) }]));
  }

  setSummary(sessionId: string, summary: StoredSummary): void {
    this.db
      .prepare("INSERT OR REPLACE INTO session_summaries (session_id, text, message_count, at) VALUES (?, ?, ?, ?)")
      .run(sessionId, summary.text, summary.messageCount, summary.at);
  }

  removeSummaries(sessionIds: readonly string[]): void {
    if (!sessionIds.length) return;
    transaction(this.db, () => {
      for (const id of sessionIds) this.db.prepare("DELETE FROM session_summaries WHERE session_id = ?").run(id);
    });
  }

  /** When summaries were first enabled (older untouched chats aren't backfilled); set once. */
  summariesEnabledAt(now: number): number {
    return transaction(this.db, () => {
      const at = getMetaJson<number>(this.db, "summaries_enabled_at");
      if (typeof at === "number") return at;
      setMetaJson(this.db, "summaries_enabled_at", now);
      return now;
    });
  }

  // Lifecycle -------------------------------------------------------------------------------------

  /** Nothing is buffered any more (every change is written at once); kept for callers. */
  flush(): void {}

  /** Stop polling and close the database. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.gcTimer) clearInterval(this.gcTimer);
    if (this.gcSoon) clearTimeout(this.gcSoon);
    this.gcTimer = this.gcSoon = null;
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export const SETTINGS_EXPORT_FILE = "settings.export.json";

/** Command receipts are kept this long (a retry comes within seconds; a day is plenty). */
const COMMAND_RECEIPT_TTL_MS = 24 * 3600_000;

/** A page of `transcript` by turn: the newest `turns` turns before index `before`. */
export function pageOf(transcript: Transcript, { before, turns }: { before?: number; turns: number }): TranscriptPage {
  const end = Math.max(0, Math.min(before ?? transcript.messages.length, transcript.messages.length));
  const start = turnPageStart(transcript.messages, end, Math.max(1, turns));
  const messages = transcript.messages.slice(start, end);
  const ids = toolCallIdsOf(messages);
  const toolResults: Record<string, ToolResult> = {};
  for (const [id, result] of Object.entries(transcript.toolResults)) if (ids.has(id)) toolResults[id] = result;
  return { messages, toolResults, start, total: transcript.messages.length };
}
