/**
 * REST client for chat search (I-045) and the chat finder (I-046). See docs/ARCHITECTURE.md.
 */
import type { AskResponse, SearchResponse } from "@glade/protocol";
import { request, type RequestFn } from "./api";

/** Full-text search over all chats (titles, summaries, messages). */
export function searchChats(q: string, limit = 20, via: RequestFn = request): Promise<SearchResponse> {
  return via<SearchResponse>("GET", `/search?${new URLSearchParams({ q, limit: String(limit) })}`);
}

/** Natural-language chat finder: a fast model picks the chats matching `query`. */
export function askChats(query: string, limit = 3, via: RequestFn = request): Promise<AskResponse> {
  return via<AskResponse>("POST", "/search/ask", { query, limit });
}
