/**
 * Search across chats (I-045) and the natural-language chat finder (I-046).
 *
 * - Text comes from the harness's session files via a {@link SessionTextReader} (built from
 *   `AgentHarness.statSession`/`readSessionText` in `create.ts`), never from running agents. Extracted text is cached in
 *   `<dataDir>/search-index.json` keyed by session id with the file's mtime/size, so a restart
 *   only re-reads files that changed.
 * - Freshness: files are re-`stat`ed (cheap) before each search when the last check is older
 *   than a second, on a background poll, and shortly after `onRunEnd`. Titles and summaries are
 *   re-indexed whenever they change.
 * - Summaries: after a session settles (not running, new messages since the last summary), a
 *   one-line summary is generated with the fast model, one at a time, and kept in
 *   `<dataDir>/session-summaries.json`. Only sessions active since the feature was first enabled
 *   are summarized (no backfill of old chats); `settings.general.generateSummaries` turns it off.
 * - `ask`: keyword candidates (any word) padded with recent chats, then the fast model picks the
 *   best matches (`finder.ts`). Without a model (or on failure) it falls back to keyword ranking.
 */
import { join } from "node:path";
import {
  modelKey,
  type AskMatch,
  type AskResponse,
  type ModelInfo,
  type ModelRef,
  type Project,
  type SearchHit,
  type SearchResponse,
  type SessionSummary,
  type Settings,
  type WorkspaceSummary,
} from "@glade/protocol";
import { JsonFile } from "../../store/json-file.js";
import { cleanSummary, finderPrompt, parseFinderReply, summaryPrompt, type FinderCandidate } from "./finder.js";
import { TextIndex, type FieldInput } from "./text-index.js";
import type { FastModel, SessionTextMessage, SessionTextReader } from "./types.js";

/** The fast model used when no title model is set and the harness lists it. */
export const DEFAULT_FAST_MODEL: ModelRef = { provider: "anthropic", id: "claude-haiku-4-5" };

/** What the search service needs from the app (AppService satisfies it). */
export interface SearchAppSource {
  listSessions(): SessionSummary[];
  listWorkspaces(): WorkspaceSummary[];
  listProjects(): Project[];
  getSettings(): Settings;
  listModels(): Promise<ModelInfo[]>;
}

export interface SearchServiceOptions {
  app: SearchAppSource;
  /** Where the index cache and summaries are stored. */
  dataDir: string;
  /** Session readers by harness id (`sessionReaders(harnesses)` in `create.ts`). */
  readers: Readonly<Record<string, SessionTextReader>>;
  /** One-shot fast model; without it summaries are off and `ask` uses keyword ranking. */
  fastModel?: FastModel;
  /** Background poll interval (0 = no timer; tests). Default 20 s. */
  pollMs?: number;
  /** Delay after a run ends before re-reading the file and summarizing. Default 1.5 s. */
  runEndDelayMs?: number;
  /** Write debounce for the cache files. */
  debounceMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

interface CachedText {
  ref: string;
  mtimeMs: number;
  size: number;
  name: string | null;
  messages: SessionTextMessage[];
}

interface IndexFile {
  version: 1;
  sessions: Record<string, CachedText>;
}

interface StoredSummary {
  text: string;
  /** Number of messages summarized (a new summary is due when it changes). */
  messageCount: number;
  at: number;
}

interface SummariesFile {
  version: 1;
  /** When summaries were first enabled; older, untouched sessions aren't backfilled. */
  enabledAt: number;
  summaries: Record<string, StoredSummary>;
}

/** Longest message text kept in the cache (very long replies are rare and mostly code). */
const MAX_MESSAGE_CHARS = 20_000;
const FRESH_MS = 1000;
const SUMMARY_RETRY_MS = 10 * 60_000;
const CANDIDATES = 20;
const RECENT_PAD = 25;

export class SearchService {
  private readonly index = new TextIndex();
  private readonly cache: JsonFile<IndexFile>;
  private readonly summaries: JsonFile<SummariesFile>;
  /** sessionId -> key of what's indexed (re-index when it changes). */
  private readonly indexed = new Map<string, string>();
  private refreshing: Promise<void> | null = null;
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private readonly timers = new Set<NodeJS.Timeout>();
  private poll: NodeJS.Timeout | null = null;
  private summaryQueue: string[] = [];
  private summarizing = false;
  private readonly summaryFailedAt = new Map<string, number>();
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly options: SearchServiceOptions) {
    this.now = options.now ?? Date.now;
    const debounce = options.debounceMs ?? 2000;
    this.cache = new JsonFile(join(options.dataDir, "search-index.json"), () => ({ version: 1, sessions: {} }), debounce);
    this.summaries = new JsonFile(
      join(options.dataDir, "session-summaries.json"),
      () => ({ version: 1, enabledAt: this.now(), summaries: {} }),
      debounce,
    );
    const pollMs = options.pollMs ?? 20_000;
    if (pollMs > 0) {
      this.poll = setInterval(() => void this.refresh().catch(this.logError), pollMs);
      this.poll.unref();
      this.later(() => void this.refresh().catch(this.logError), 1000);
    }
  }

  private readonly logError = (err: Error) => this.options.log?.(`search: ${err.message}`);

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.disposed) fn();
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  // -------------------------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------------------------

  /** Full-text search (every query word must occur somewhere in the chat). */
  async search(query: string, limit = 20): Promise<SearchResponse> {
    const q = query.trim();
    if (!q) return { query, hits: [] };
    await this.ensureFresh();
    const ctx = this.context();
    const hits: SearchHit[] = [];
    for (const hit of this.index.search(q, { mode: "all", limit: limit * 2 })) {
      const found = ctx.resolve(hit.sessionId);
      if (!found) continue;
      const { session, workspace, project } = found;
      hits.push({
        workspaceId: workspace.id,
        sessionId: session.id,
        sessionKind: session.kind,
        title: session.title,
        workspaceTitle: workspace.title,
        projectId: workspace.projectId,
        project: project?.name ?? null,
        snippet: hit.snippet,
        matchedIn: hit.kind,
        score: hit.score,
        updatedAt: session.lastActivityAt,
      });
      if (hits.length >= limit) break;
    }
    return { query, hits };
  }

  /** Natural-language chat finder: the fast model picks the best matches among candidates. */
  async ask(query: string, limit = 3): Promise<AskResponse> {
    const q = query.trim();
    if (!q) return { query, matches: [], confident: false, model: null };
    await this.ensureFresh();
    const ctx = this.context();
    const keyword = this.index.search(q, { mode: "any", limit: CANDIDATES }).filter((h) => ctx.resolve(h.sessionId));
    const ids = keyword.map((h) => h.sessionId);
    const excerpts = new Map(keyword.map((h) => [h.sessionId, h.kind === "title" ? null : h.snippet.text]));
    // Paraphrased requests may share no words with the chat: offer the most recent chats too.
    const recent = ctx.sessions.filter((s) => !ids.includes(s.id)).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    for (const s of recent) {
      if (ids.length >= RECENT_PAD) break;
      ids.push(s.id);
    }

    const fallback = (): AskResponse => ({
      query,
      matches: keyword.slice(0, limit).map((h) => this.askMatch(ctx, h.sessionId, "")!).filter(Boolean),
      confident: false,
      model: null,
    });
    const fast = this.options.fastModel;
    if (!fast || ids.length === 0) return fallback();

    const candidates: FinderCandidate[] = ids.map((id, i) => {
      const { session, workspace, project } = ctx.resolve(id)!;
      const opening = this.cache.get().sessions[id]?.messages.find((m) => m.role === "user")?.text ?? null;
      return {
        label: `c${i + 1}`,
        title: session.title || workspace.title,
        project: project?.name ?? null,
        updatedAt: session.lastActivityAt,
        summary: this.summaryOf(id),
        opening,
        excerpt: excerpts.get(id) ?? null,
      };
    });
    const model = await this.fastModelRef();
    const reply = await fast({ prompt: finderPrompt(q, candidates, this.now()), model, timeoutMs: 30_000 });
    const parsed = reply ? parseFinderReply(reply, new Set(candidates.map((c) => c.label))) : null;
    if (!parsed) return fallback();
    const byLabel = new Map(candidates.map((c, i) => [c.label, ids[i]!]));
    return {
      query,
      matches: parsed.matches
        .slice(0, limit)
        .map((m) => this.askMatch(ctx, byLabel.get(m.label)!, m.reason))
        .filter((m): m is AskMatch => m !== null),
      confident: parsed.confident,
      model: model ? modelKey(model) : "default",
    };
  }

  /** The stored one-line summary of a session, if any. */
  summaryOf(sessionId: string): string | null {
    return this.summaries.get().summaries[sessionId]?.text ?? null;
  }

  /**
   * Call when a session's run ends (from AppService `run_end`): re-reads its file shortly after
   * (pi may still be flushing) and queues a summary. Harmless if never called: the poll catches up.
   */
  onRunEnd(_sessionId: string): void {
    this.later(() => void this.refresh().catch(this.logError), this.options.runEndDelayMs ?? 1500);
  }

  /** Bring the index up to date now (stat every session file, re-read changed ones). */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
      this.lastRefresh = this.now();
    });
    return this.refreshing;
  }

  /** Resolves once queued summaries are done (tests). */
  async idle(): Promise<void> {
    while (this.refreshing || this.summarizing || this.summaryQueue.length) {
      await (this.refreshing ?? new Promise((r) => setTimeout(r, 5)));
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.poll) clearInterval(this.poll);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.cache.flush();
    this.summaries.flush();
  }

  // -------------------------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------------------------

  private async ensureFresh(): Promise<void> {
    if (this.refreshing || this.now() - this.lastRefresh > FRESH_MS) await this.refresh();
  }

  private async doRefresh(): Promise<void> {
    const ctx = this.context();
    const file = this.cache.get();
    const cached = { ...file.sessions };
    let changed = false;
    const live = new Set<string>();
    for (const session of ctx.sessions) {
      live.add(session.id);
      const reader = this.options.readers[session.harness];
      const ref = session.sessionRef;
      if (reader && ref) {
        const stat = await reader.stat(ref);
        const prev = cached[session.id];
        if (!stat) {
          if (prev) {
            delete cached[session.id];
            changed = true;
          }
        } else if (!prev || prev.ref !== ref || prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size) {
          const text = await reader.read(ref);
          if (text) {
            cached[session.id] = {
              ref,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              name: text.name,
              messages: text.messages.map((m) => (m.text.length > MAX_MESSAGE_CHARS ? { ...m, text: m.text.slice(0, MAX_MESSAGE_CHARS) } : m)),
            };
            changed = true;
          }
        }
      }
      this.indexSession(session, ctx.workspaces.get(session.workspaceId), cached[session.id]);
    }
    // Forget deleted sessions.
    for (const id of Object.keys(cached)) {
      if (!live.has(id)) {
        delete cached[id];
        changed = true;
      }
    }
    for (const id of [...this.indexed.keys()]) {
      if (!live.has(id)) {
        this.index.remove(id);
        this.indexed.delete(id);
      }
    }
    const summaries = this.summaries.get();
    const stale = Object.keys(summaries.summaries).filter((id) => !live.has(id));
    if (stale.length) {
      // An operation on the file's current content: another server shares it (I-062).
      this.summaries.update((file) => {
        const next = { ...file.summaries };
        for (const id of stale) delete next[id];
        return { ...file, summaries: next };
      });
    }
    if (changed) this.cache.set({ version: 1, sessions: cached });
    this.queueSummaries(ctx.sessions);
  }

  private indexSession(session: SessionSummary, workspace: WorkspaceSummary | undefined, text: CachedText | undefined): void {
    const summary = this.summaryOf(session.id);
    const titles = [...new Set([session.title, workspace?.title, text?.name].filter((t): t is string => !!t?.trim()))];
    const key = JSON.stringify([titles, summary, text?.mtimeMs ?? 0, text?.size ?? 0]);
    if (this.indexed.get(session.id) === key) return;
    const fields: FieldInput[] = [{ kind: "title", text: titles.join("\n") }];
    if (summary) fields.push({ kind: "summary", text: summary });
    for (const m of text?.messages ?? []) fields.push({ kind: m.role, text: m.text });
    this.index.set(session.id, fields);
    this.indexed.set(session.id, key);
  }

  // -------------------------------------------------------------------------------------------
  // Summaries
  // -------------------------------------------------------------------------------------------

  private queueSummaries(sessions: readonly SessionSummary[]): void {
    const settings = this.options.app.getSettings();
    if (!this.options.fastModel || settings.general.generateSummaries === false) return;
    const { enabledAt, summaries } = this.summaries.get();
    const now = this.now();
    for (const session of sessions) {
      if (session.running || session.lastActivityAt < enabledAt) continue;
      const count = this.cache.get().sessions[session.id]?.messages.length ?? 0;
      if (count < 2 || summaries[session.id]?.messageCount === count) continue;
      const failed = this.summaryFailedAt.get(session.id);
      if (failed && now - failed < SUMMARY_RETRY_MS) continue;
      if (!this.summaryQueue.includes(session.id)) this.summaryQueue.push(session.id);
    }
    void this.drainSummaries();
  }

  private async drainSummaries(): Promise<void> {
    if (this.summarizing) return;
    this.summarizing = true;
    try {
      for (let id = this.summaryQueue.shift(); id && !this.disposed; id = this.summaryQueue.shift()) {
        await this.summarize(id).catch((err: Error) => {
          this.summaryFailedAt.set(id!, this.now());
          this.logError(err);
        });
      }
    } finally {
      this.summarizing = false;
    }
  }

  private async summarize(sessionId: string): Promise<void> {
    const fast = this.options.fastModel;
    const text = this.cache.get().sessions[sessionId];
    const session = this.options.app.listSessions().find((s) => s.id === sessionId);
    if (!fast || !text || !session) return;
    const count = text.messages.length;
    const reply = await fast({ prompt: summaryPrompt(session.title, text.messages), model: await this.fastModelRef() });
    const summary = cleanSummary(reply);
    if (!summary) {
      this.summaryFailedAt.set(sessionId, this.now());
      return;
    }
    const entry = { text: summary, messageCount: count, at: this.now() };
    this.summaries.update((file) => ({ ...file, summaries: { ...file.summaries, [sessionId]: entry } }));
    // Re-index with the new summary.
    const workspace = this.options.app.listWorkspaces().find((w) => w.id === session.workspaceId);
    this.indexSession(session, workspace, text);
  }

  /** The title model setting, else Haiku when the harness lists it, else the harness default. */
  private async fastModelRef(): Promise<ModelRef | null> {
    const configured = this.options.app.getSettings().models.titleModel;
    if (configured) return configured;
    const models = await this.options.app.listModels().catch(() => [] as ModelInfo[]);
    return models.some((m) => m.provider === DEFAULT_FAST_MODEL.provider && m.id === DEFAULT_FAST_MODEL.id) ? DEFAULT_FAST_MODEL : null;
  }

  // -------------------------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------------------------

  private context() {
    const sessions = this.options.app.listSessions();
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const workspaces = new Map(this.options.app.listWorkspaces().map((w) => [w.id, w]));
    const projects = new Map(this.options.app.listProjects().map((p) => [p.id, p]));
    return {
      sessions,
      workspaces,
      resolve(id: string) {
        const session = byId.get(id);
        const workspace = session && workspaces.get(session.workspaceId);
        if (!session || !workspace) return null;
        return { session, workspace, project: workspace.projectId ? (projects.get(workspace.projectId) ?? null) : null };
      },
    };
  }

  private askMatch(ctx: ReturnType<SearchService["context"]>, sessionId: string, reason: string): AskMatch | null {
    const found = ctx.resolve(sessionId);
    if (!found) return null;
    const { session, workspace, project } = found;
    return {
      workspaceId: workspace.id,
      sessionId: session.id,
      sessionKind: session.kind,
      title: session.title || workspace.title,
      project: project?.name ?? null,
      summary: this.summaryOf(session.id),
      reason,
      updatedAt: session.lastActivityAt,
    };
  }
}

