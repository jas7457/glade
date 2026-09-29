/**
 * Search across chats (I-045) and the natural-language chat finder (I-046).
 *
 * - Text comes from Glade's store (I-121: the `messages` table keeps each message's plain text) via
 *   a {@link SessionTextSource} (`create.ts`), never from running agents or harness files. Each
 *   session's text is kept in memory with its transcript version, so only changed ones are re-read.
 * - Freshness: versions are re-checked (one query) before each search when the last check is
 *   older than a second, on a background poll, and shortly after `onRunEnd`. Titles and summaries
 *   are re-indexed whenever they change.
 * - Summaries: after a session settles (not running, new messages since the last summary), a
 *   one-line summary is generated with the small model, one at a time, and kept in the store
 *   (`session_summaries`). Only sessions active since the feature was first enabled are
 *   summarized (no backfill of old chats); `settings.general.generateSummaries` turns it off.
 * - `ask`: keyword candidates (any word) padded with recent chats, then the small model picks the
 *   best matches (`finder.ts`). Without a model (or on failure) it falls back to keyword ranking.
 */
import {
  modelKey,
  type AskMatch,
  type AskResponse,
  type MessageAnchor,
  type ModelInfo,
  type ModelRef,
  type Project,
  type SearchHit,
  type SearchResponse,
  type SessionSummary,
  type Settings,
  type WorkspaceSummary,
} from "@glade/protocol";
import { agentMessageText, isAgentMessage } from "./agent-text.js";
import { cleanSummary, finderPrompt, parseFinderReply, summaryPrompt, type FinderCandidate } from "./finder.js";
import { TextIndex, type FieldInput } from "./text-index.js";
import type { SessionTextMessage, SessionTextSource, SmallModel, StoredSummary, SummaryStore } from "./types.js";

/** The small model used when none is set and the harness lists it. */
export const DEFAULT_SMALL_MODEL: ModelRef = { provider: "anthropic", id: "claude-haiku-4-5" };

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
  /** Each session's stored text (the store, `create.ts`). */
  texts: SessionTextSource;
  /** Where summaries are kept (the store; memory when omitted). */
  summaries?: SummaryStore;
  /** One-shot fast model; without it summaries are off and `ask` uses keyword ranking. */
  smallModel?: SmallModel;
  /** Background poll interval (0 = no timer; tests). Default 20 s. */
  pollMs?: number;
  /** Delay after a run ends before re-reading the file and summarizing. Default 1.5 s. */
  runEndDelayMs?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

interface CachedText {
  version: string;
  name: string | null;
  messages: SessionTextMessage[];
}

/** Summaries in memory (tests, and when no store is given). */
export class MemorySummaryStore implements SummaryStore {
  private readonly map = new Map<string, StoredSummary>();
  private enabled: number | null = null;
  get(id: string) {
    return this.map.get(id) ?? null;
  }
  list() {
    return new Map(this.map);
  }
  set(id: string, summary: StoredSummary) {
    this.map.set(id, summary);
  }
  remove(ids: readonly string[]) {
    for (const id of ids) this.map.delete(id);
  }
  enabledAt(now: number) {
    this.enabled ??= now;
    return this.enabled;
  }
}

/** Longest message text kept in the cache (very long replies are rare and mostly code). */
const MAX_MESSAGE_CHARS = 20_000;
const FRESH_MS = 1000;
const SUMMARY_RETRY_MS = 10 * 60_000;
const CANDIDATES = 20;

/** Options of {@link SearchService.search} and {@link SearchService.ask}. */
export interface SearchQueryOptions {
  /** Session ids to leave out (e.g. the asking agent's own chat, so it can't win). */
  exclude?: ReadonlySet<string> | readonly string[];
}

const toSet = (ids: SearchQueryOptions["exclude"]): ReadonlySet<string> | undefined =>
  ids === undefined ? undefined : ids instanceof Set ? ids : new Set(ids as readonly string[]);
const RECENT_PAD = 25;

export class SearchService {
  private readonly index = new TextIndex();
  /** sessionId -> its text at a transcript version. */
  private readonly cache = new Map<string, CachedText>();
  private readonly summaries: SummaryStore;
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
    this.summaries = options.summaries ?? new MemorySummaryStore();
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
  async search(query: string, limit = 20, opts: SearchQueryOptions = {}): Promise<SearchResponse> {
    const q = query.trim();
    if (!q) return { query, hits: [] };
    await this.ensureFresh();
    const ctx = this.context();
    const hits: SearchHit[] = [];
    for (const hit of this.index.search(q, { mode: "all", limit: limit * 2, exclude: toSet(opts.exclude) })) {
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
        ...(hit.message ? { message: hit.message } : {}),
        score: hit.score,
        updatedAt: session.lastActivityAt,
      });
      if (hits.length >= limit) break;
    }
    return { query, hits };
  }

  /** Natural-language chat finder: the small model picks the best matches among candidates. */
  async ask(query: string, limit = 3, opts: SearchQueryOptions = {}): Promise<AskResponse> {
    const q = query.trim();
    if (!q) return { query, matches: [], confident: false, model: null };
    await this.ensureFresh();
    const ctx = this.context();
    const exclude = toSet(opts.exclude);
    const keyword = this.index.search(q, { mode: "any", limit: CANDIDATES, exclude }).filter((h) => ctx.resolve(h.sessionId));
    const ids = keyword.map((h) => h.sessionId);
    const excerpts = new Map(keyword.map((h) => [h.sessionId, h.kind === "title" ? null : h.snippet.text]));
    const anchors = new Map<string, MessageAnchor>();
    for (const h of keyword) if (h.message) anchors.set(h.sessionId, h.message);
    // Paraphrased requests may share no words with the chat: offer the most recent chats too.
    const recent = ctx.sessions.filter((s) => !ids.includes(s.id) && !exclude?.has(s.id)).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    for (const s of recent) {
      if (ids.length >= RECENT_PAD) break;
      ids.push(s.id);
    }

    const fallback = (): AskResponse => ({
      query,
      matches: keyword.slice(0, limit).map((h) => this.askMatch(ctx, h.sessionId, "", anchors)!).filter(Boolean),
      confident: false,
      model: null,
    });
    const fast = this.options.smallModel;
    if (!fast || ids.length === 0) return fallback();

    const candidates: FinderCandidate[] = ids.map((id, i) => {
      const { session, workspace, project } = ctx.resolve(id)!;
      const opening = this.cache.get(id)?.messages.find((m) => m.role === "user" && !isAgentMessage(m))?.text ?? null;
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
    const model = await this.smallModelRef();
    const reply = await fast({ prompt: finderPrompt(q, candidates, this.now()), model, timeoutMs: 30_000 });
    const parsed = reply ? parseFinderReply(reply, new Set(candidates.map((c) => c.label))) : null;
    if (!parsed) return fallback();
    const byLabel = new Map(candidates.map((c, i) => [c.label, ids[i]!]));
    return {
      query,
      matches: parsed.matches
        .slice(0, limit)
        .map((m) => this.askMatch(ctx, byLabel.get(m.label)!, m.reason, anchors))
        .filter((m): m is AskMatch => m !== null),
      confident: parsed.confident,
      model: model ? modelKey(model) : "default",
    };
  }

  /** The stored one-line summary of a session, if any. */
  summaryOf(sessionId: string): string | null {
    return this.summaries.get(sessionId)?.text ?? null;
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
  }

  // -------------------------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------------------------

  private async ensureFresh(): Promise<void> {
    if (this.refreshing || this.now() - this.lastRefresh > FRESH_MS) await this.refresh();
  }

  private async doRefresh(): Promise<void> {
    const ctx = this.context();
    const live = new Set<string>();
    for (const session of ctx.sessions) {
      live.add(session.id);
      const version = await this.options.texts.version(session);
      const prev = this.cache.get(session.id);
      if (version === null) {
        this.cache.delete(session.id);
      } else if (!prev || prev.version !== version) {
        const text = await this.options.texts.read(session);
        if (text) {
          this.cache.set(session.id, {
            version,
            name: text.name,
            messages: text.messages.map((m) => (m.text.length > MAX_MESSAGE_CHARS ? { ...m, text: m.text.slice(0, MAX_MESSAGE_CHARS) } : m)),
          });
        }
      }
      this.indexSession(session, ctx.workspaces.get(session.workspaceId), this.cache.get(session.id));
    }
    // Forget deleted sessions.
    for (const id of [...this.cache.keys()]) if (!live.has(id)) this.cache.delete(id);
    for (const id of [...this.indexed.keys()]) {
      if (!live.has(id)) {
        this.index.remove(id);
        this.indexed.delete(id);
      }
    }
    const stale = [...this.summaries.list().keys()].filter((id) => !live.has(id));
    if (stale.length) this.summaries.remove(stale);
    this.queueSummaries(ctx.sessions);
  }

  private indexSession(session: SessionSummary, workspace: WorkspaceSummary | undefined, text: CachedText | undefined): void {
    const summary = this.summaryOf(session.id);
    const titles = [...new Set([session.title, workspace?.title, text?.name].filter((t): t is string => !!t?.trim()))];
    const key = JSON.stringify([titles, summary, text?.version ?? null]);
    if (this.indexed.get(session.id) === key) return;
    const fields: FieldInput[] = [{ kind: "title", text: titles.join("\n") }];
    if (summary) fields.push({ kind: "summary", text: summary });
    for (const m of text?.messages ?? []) {
      // The timestamp locates the message in the web transcript (I-093); 0 = unknown.
      const message = m.timestamp > 0 ? { message: { role: m.role, timestamp: m.timestamp } } : {};
      // Sub-agent reports delivered as prompts aren't the user's words (I-100).
      const agent = m.role === "user" ? agentMessageText(m.text) : null;
      fields.push(agent !== null ? { kind: "agent", text: agent, ...message } : { kind: m.role, text: m.text, ...message });
    }
    this.index.set(session.id, fields);
    this.indexed.set(session.id, key);
  }

  // -------------------------------------------------------------------------------------------
  // Summaries
  // -------------------------------------------------------------------------------------------

  private queueSummaries(sessions: readonly SessionSummary[]): void {
    const settings = this.options.app.getSettings();
    if (!this.options.smallModel || settings.general.generateSummaries === false) return;
    const now = this.now();
    const enabledAt = this.summaries.enabledAt(now);
    const summaries = this.summaries.list();
    for (const session of sessions) {
      if (session.running || session.lastActivityAt < enabledAt) continue;
      const count = this.cache.get(session.id)?.messages.length ?? 0;
      if (count < 2 || summaries.get(session.id)?.messageCount === count) continue;
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
    const fast = this.options.smallModel;
    const text = this.cache.get(sessionId);
    const session = this.options.app.listSessions().find((s) => s.id === sessionId);
    if (!fast || !text || !session) return;
    const count = text.messages.length;
    const reply = await fast({ prompt: summaryPrompt(session.title, text.messages), model: await this.smallModelRef() });
    const summary = cleanSummary(reply);
    if (!summary) {
      this.summaryFailedAt.set(sessionId, this.now());
      return;
    }
    const entry = { text: summary, messageCount: count, at: this.now() };
    this.summaries.set(sessionId, entry);
    // Re-index with the new summary.
    const workspace = this.options.app.listWorkspaces().find((w) => w.id === session.workspaceId);
    this.indexSession(session, workspace, text);
  }

  /** The small model setting, else Haiku when the harness lists it, else the harness default. */
  private async smallModelRef(): Promise<ModelRef | null> {
    const configured = this.options.app.getSettings().models.smallModel;
    if (configured) return configured;
    const all = await this.options.app.listModels().catch(() => [] as ModelInfo[]);
    // The default harness's models come first (I-173: other harnesses' follow, tagged).
    const models = all.filter((m) => !m.harness || m.harness === all[0]?.harness);
    return models.some((m) => m.provider === DEFAULT_SMALL_MODEL.provider && m.id === DEFAULT_SMALL_MODEL.id) ? DEFAULT_SMALL_MODEL : null;
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

  private askMatch(
    ctx: ReturnType<SearchService["context"]>,
    sessionId: string,
    reason: string,
    anchors: ReadonlyMap<string, MessageAnchor>,
  ): AskMatch | null {
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
      ...(anchors.has(session.id) ? { message: anchors.get(session.id)! } : {}),
      updatedAt: session.lastActivityAt,
    };
  }
}

