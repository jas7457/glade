/**
 * Chat tools for agents (I-091): find, read and open the user's Glade chats from inside a chat.
 *
 * Token-authenticated agent API routes (`/api/agents/chats/…`, next to the I-037 ones; the token
 * names the calling session), used by the ext-kit agent-teams extension's Glade backend
 * (`find_chats`, `read_chat`, `open_chat`):
 *
 *   POST /api/agents/chats/find  FindChatsRequest → FindChatsResponse (the ⌘K Ask pipeline + keyword hits)
 *   POST /api/agents/chats/read  ReadChatRequest  → ReadChatResponse  (summary + last messages; no agent started)
 *   POST /api/agents/chats/open  OpenChatRequest  → OpenChatResponse  (Glade windows navigate to it: `open_chat` push)
 *
 * The caller's own session is left out of `find` results unless `includeSelf` is set.
 */

/** Defaults and caps (the server clamps requests to them). */
export const CHAT_TOOLS_LIMITS = {
  findDefault: 5,
  findMax: 10,
  readDefault: 10,
  readMax: 40,
  /** Longest message text returned by `read` (longer ones are cut, `truncated: true`). */
  messageChars: 2000,
  /** Total message text returned by one `read` (oldest messages are dropped first). */
  readChars: 16_000,
  /** Longest snippet returned by `find`. */
  snippetChars: 240,
} as const;

/** One chat (a session: a tab of a workspace, or a sub-agent). */
export interface ChatInfo {
  workspaceId: string;
  sessionId: string;
  /** `main` sessions are tabs; `subagent` ones open via their workspace. */
  sessionKind: "main" | "subagent";
  /** Session (tab) title, else the workspace title. */
  title: string;
  /** Workspace (sidebar row) title. */
  workspaceTitle: string;
  /** Project name, or `null` for standalone chats. */
  project: string | null;
  /** Last activity (ms epoch). */
  updatedAt: number;
  /** One-line summary, when one has been generated. */
  summary: string | null;
}

export interface FindChatsRequest {
  /** What the user is looking for, in their words, e.g. "where we added the new button". */
  query: string;
  /** Max matches (default {@link CHAT_TOOLS_LIMITS.findDefault}, max `findMax`). */
  limit?: number;
  /** Also return the calling chat itself (default false). */
  includeSelf?: boolean;
}

export interface ChatMatch extends ChatInfo {
  /** Matching passage (plain text, bounded), when the keyword search found one. */
  snippet: string | null;
  /** Why the fast model picked it (short); empty for keyword matches. */
  reason: string;
  /** `model`: picked by the fast model; `keyword`: keyword ranking (fallback or padding). */
  matchedBy: "model" | "keyword";
}

export interface FindChatsResponse {
  query: string;
  /** Best first. */
  matches: ChatMatch[];
  /** The model is confident the first match is the one meant. */
  confident: boolean;
  /** Model used (`provider/id` or "default"), `null` when keyword ranking was used. */
  model: string | null;
}

export interface ReadChatRequest {
  /** A session id (from `find`), or a workspace id (its active tab). */
  id: string;
  /** How many of the last user/assistant messages (default `readDefault`, max `readMax`). */
  limit?: number;
}

export interface ChatTextMessage {
  role: "user" | "assistant";
  /** Plain text (no tool output, no thinking), at most `messageChars`. */
  text: string;
  /** ms epoch (0 if unknown). */
  timestamp: number;
  /** The text was cut. */
  truncated?: boolean;
}

export interface ReadChatResponse {
  chat: ChatInfo;
  /** Oldest first: the last `limit` messages (fewer if they'd exceed `readChars`). */
  messages: ChatTextMessage[];
  /** User/assistant text messages in the whole chat. */
  totalMessages: number;
}

export interface OpenChatRequest {
  /** A session id (from `find`), or a workspace id. */
  id: string;
}

export interface OpenChatResponse {
  chat: ChatInfo;
  /** Glade windows that were told to show it (0 = no window is open). */
  windows: number;
}
