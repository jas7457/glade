/**
 * Chat tools for agents (I-091): find, read and open the user's chats from inside a chat. Behind
 * the token-authenticated `/api/agents/chats/…` routes (`http/agents.ts`); the ext-kit agent-teams
 * extension exposes them as `find_chats`, `read_chat` and `open_chat`.
 *
 * - find: the ⌘K Ask pipeline (`SearchService.ask`: keyword candidates + fast model, keyword
 *   fallback), padded with full-text hits (`SearchService.search`) that also supply snippets.
 * - read: the chat's summary plus its last N user/assistant text messages, bounded, read from the
 *   persisted session (`AppService.readSessionText`); no agent process is started.
 * - open: pushes `open_chat` so every Glade window navigates to it (`AppService.requestOpenChat`).
 *
 * The caller's own session is left out of `find` unless asked. Harness-agnostic.
 */
import {
  CHAT_TOOLS_LIMITS,
  activeMainSessionId,
  type ChatInfo,
  type ChatMatch,
  type ChatTextMessage,
  type FindChatsRequest,
  type FindChatsResponse,
  type OpenChatResponse,
  type Project,
  type ReadChatRequest,
  type ReadChatResponse,
  type SessionSummary,
  type WorkspaceSummary,
} from "@glade/protocol";
import type { SessionText } from "../harness/types.js";
import { HttpError } from "./app-service.js";
import type { SearchService } from "./search/search-service.js";

/** What the chat tools need from the app (AppService satisfies it). */
export interface ChatToolsApp {
  listSessions(): SessionSummary[];
  listWorkspaces(): WorkspaceSummary[];
  listProjects(): Project[];
  readSessionText(sessionId: string): Promise<SessionText | null>;
  requestOpenChat(sessionId: string): number;
}

type ChatSearch = Pick<SearchService, "ask" | "search" | "summaryOf">;

/** Clamp a requested count to `[1, max]` (`fallback` when missing or invalid). */
export function clampCount(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), max) : fallback;
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: `${text.slice(0, max - 1)}…`, truncated: true } : { text, truncated: false };
}

const oneLine = (text: string, max: number) => clip(text.replace(/\s+/g, " ").trim(), max).text;

/**
 * The last `limit` messages, oldest first, each at most `messageChars`, together at most
 * `totalChars` (older messages are dropped first; the newest one is always kept).
 */
export function lastMessages(text: SessionText | null, limit: number, messageChars: number, totalChars: number): ChatTextMessage[] {
  const out: ChatTextMessage[] = [];
  let used = 0;
  const all = text?.messages ?? [];
  for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
    const m = all[i]!;
    const { text: body, truncated } = clip(m.text.trim(), messageChars);
    if (out.length > 0 && used + body.length > totalChars) break;
    used += body.length;
    out.push({ role: m.role, text: body, timestamp: m.timestamp, ...(truncated ? { truncated } : {}) });
  }
  return out.reverse();
}

export class ChatTools {
  constructor(
    private readonly app: ChatToolsApp,
    private readonly search: ChatSearch | null,
  ) {}

  async find(callerId: string, req: FindChatsRequest): Promise<FindChatsResponse> {
    const search = this.requireSearch();
    const query = req.query.trim().slice(0, 1000);
    const limit = clampCount(req.limit, CHAT_TOOLS_LIMITS.findDefault, CHAT_TOOLS_LIMITS.findMax);
    const opts = req.includeSelf ? {} : { exclude: [callerId] };
    const [ask, keyword] = await Promise.all([search.ask(query, limit, opts), search.search(query.slice(0, 500), limit * 2, opts)]);
    const snippets = new Map<string, string>();
    for (const hit of keyword.hits) {
      if (!snippets.has(hit.sessionId) && hit.matchedIn !== "title") snippets.set(hit.sessionId, oneLine(hit.snippet.text, CHAT_TOOLS_LIMITS.snippetChars));
    }
    const ctx = this.context();
    const matches: ChatMatch[] = [];
    const add = (sessionId: string, reason: string, matchedBy: ChatMatch["matchedBy"]) => {
      if (matches.length >= limit || matches.some((m) => m.sessionId === sessionId)) return;
      if (!req.includeSelf && sessionId === callerId) return;
      const chat = ctx.info(sessionId);
      if (chat) matches.push({ ...chat, snippet: snippets.get(sessionId) ?? null, reason, matchedBy });
    };
    for (const m of ask.matches) add(m.sessionId, m.reason, ask.model ? "model" : "keyword");
    for (const hit of keyword.hits) add(hit.sessionId, "", "keyword");
    return { query: req.query, matches, confident: ask.confident && matches[0]?.sessionId === ask.matches[0]?.sessionId, model: ask.model };
  }

  async read(req: ReadChatRequest): Promise<ReadChatResponse> {
    const session = this.resolve(req.id);
    const limit = clampCount(req.limit, CHAT_TOOLS_LIMITS.readDefault, CHAT_TOOLS_LIMITS.readMax);
    const text = await this.app.readSessionText(session.id);
    return {
      chat: this.context().info(session.id)!,
      messages: lastMessages(text, limit, CHAT_TOOLS_LIMITS.messageChars, CHAT_TOOLS_LIMITS.readChars),
      totalMessages: text?.messages.length ?? 0,
    };
  }

  open(id: string): OpenChatResponse {
    const session = this.resolve(id);
    const windows = this.app.requestOpenChat(session.id);
    return { chat: this.context().info(session.id)!, windows };
  }

  // -------------------------------------------------------------------------------------------

  private requireSearch(): ChatSearch {
    if (!this.search) throw new HttpError(501, "Chat search isn't available in this Glade server");
    return this.search;
  }

  /** A session id, or a workspace id (its focused main tab). 404 otherwise. */
  private resolve(id: string): SessionSummary {
    const sessions = this.app.listSessions();
    const direct = sessions.find((s) => s.id === id);
    if (direct) return direct;
    const workspace = this.app.listWorkspaces().find((w) => w.id === id);
    const tab = workspace && activeMainSessionId(workspace, sessions);
    const session = tab ? sessions.find((s) => s.id === tab) : undefined;
    if (!session) throw new HttpError(404, `No chat with id "${id}" (use a sessionId from find_chats)`);
    return session;
  }

  private context() {
    const sessions = new Map(this.app.listSessions().map((s) => [s.id, s]));
    const workspaces = new Map(this.app.listWorkspaces().map((w) => [w.id, w]));
    const projects = new Map(this.app.listProjects().map((p) => [p.id, p]));
    const summaryOf = (id: string) => this.search?.summaryOf(id) ?? null;
    return {
      info(sessionId: string): ChatInfo | null {
        const session = sessions.get(sessionId);
        const workspace = session && workspaces.get(session.workspaceId);
        if (!session || !workspace) return null;
        return {
          workspaceId: workspace.id,
          sessionId: session.id,
          sessionKind: session.kind,
          title: session.title || workspace.title,
          workspaceTitle: workspace.title,
          project: workspace.projectId ? (projects.get(workspace.projectId)?.name ?? null) : null,
          updatedAt: session.lastActivityAt,
          summary: summaryOf(session.id),
        };
      },
    };
  }
}
