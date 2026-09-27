/**
 * Search across chats (I-045) and the natural-language chat finder (I-046).
 *
 * `GET /api/search?q=&limit=` → {@link SearchResponse}: full-text hits over session titles,
 * summaries, user messages and assistant text (tool output and thinking aren't indexed).
 * `POST /api/search/ask` ({@link AskRequest}) → {@link AskResponse}: a fast model picks the
 * best-matching chats among ~20 candidates retrieved with the same index. The ask endpoint is
 * shaped so an agent tool (`find_chats`) can reuse it later.
 */

/** Text with character ranges `[start, end)` to emphasise (matched query words). */
export interface HighlightedText {
  text: string;
  highlights: Array<[start: number, end: number]>;
}

export interface SearchHit {
  workspaceId: string;
  sessionId: string;
  /** `main` sessions are tabs; `subagent` ones are opened via their workspace. */
  sessionKind: "main" | "subagent";
  /** Session title (tab title). */
  title: string;
  /** Workspace (sidebar row) title. */
  workspaceTitle: string;
  projectId: string | null;
  /** Project name, or `null` for standalone chats. */
  project: string | null;
  /** Best matching passage (a message, the title or the summary). */
  snippet: HighlightedText;
  /** Where the snippet comes from. */
  matchedIn: "title" | "summary" | "user" | "assistant";
  /** Higher is better. Only meaningful within one response. */
  score: number;
  /** Last activity of the session (ms epoch). */
  updatedAt: number;
}

export interface SearchResponse {
  query: string;
  hits: SearchHit[];
}

export interface AskRequest {
  /** A natural-language request, e.g. "the chat where we added the new button". */
  query: string;
  /** Max matches to return (default 3). */
  limit?: number;
}

export interface AskMatch {
  workspaceId: string;
  sessionId: string;
  sessionKind: "main" | "subagent";
  title: string;
  project: string | null;
  /** One-line summary of the chat, when one has been generated. */
  summary: string | null;
  /** Why the model picked it (short). Empty for keyword fallback results. */
  reason: string;
  updatedAt: number;
}

export interface AskResponse {
  query: string;
  /** Best first. Empty when nothing plausible was found. */
  matches: AskMatch[];
  /** The model is confident the first match is the one meant (the UI may open it directly). */
  confident: boolean;
  /** Model used (`provider/id`), or `null` when the model was unavailable and keyword ranking was used. */
  model: string | null;
}
