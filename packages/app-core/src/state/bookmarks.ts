/**
 * Bookmarks (I-203): which messages are bookmarked, and the actions on them. The `bookmarks`
 * signal (every environment's, tagged like folders) lives in `store.ts` with the rest of the
 * shell data and is kept current by the server's pushes; this module reads it and talks to the
 * bookmark's environment. Like `folder-actions.ts`: results are applied to the signal right away
 * (pushes are idempotent), failures become toasts.
 *
 * A message is found by `MessageAnchor` (role + timestamp): an agent bookmark anchors the first
 * message of the reply (`turnAnchor`), a user bookmark its message.
 *
 * Portable client core (F-022).
 */
import { signal } from "@preact/signals";
import { anchoredText, compareBookmarks, messageText, parseAttachedFiles, sameAnchor, type Bookmark, type ChatMessage, type MessageAnchor } from "@glade/protocol";
import { apiFor, apiForSession } from "./env-api";
import { connectionFor } from "./env-registry";
import { getChatSession } from "./chat-session";
import { bookmarks, envIdOf, envIdOfSession, upsert } from "./store";
import { notify } from "./toasts";

export { bookmarks };

/** The chat (workspace id) whose bookmark list is open: the header popover / the iPhone sheet (⌘⇧D). */
export const bookmarkListOpen = signal<string | null>(null);

/** A chat's bookmarks (all its tabs and sub-agents), latest message first. */
export function bookmarksOfWorkspace(workspaceId: string, list: readonly Bookmark[] = bookmarks.value): Bookmark[] {
  return list.filter((b) => b.workspaceId === workspaceId).sort(byMessageDesc);
}

/** One session's bookmarks, latest message first. */
export function bookmarksOfSession(sessionId: string, list: readonly Bookmark[] = bookmarks.value): Bookmark[] {
  return list.filter((b) => b.sessionId === sessionId).sort(byMessageDesc);
}

const byMessageDesc = (a: Bookmark, b: Bookmark) => b.message.timestamp - a.message.timestamp || compareBookmarks(a, b);

/** Every bookmark of a message (the whole message and passages of it). */
export function bookmarksOfMessage(sessionId: string, anchor: MessageAnchor, list: readonly Bookmark[] = bookmarks.value): Bookmark[] {
  return list.filter((b) => b.sessionId === sessionId && sameAnchor(b.message, anchor));
}

/** The bookmark of the whole message (not a passage), if any. */
export function messageBookmark(sessionId: string, anchor: MessageAnchor, list: readonly Bookmark[] = bookmarks.value): Bookmark | undefined {
  return list.find((b) => b.sessionId === sessionId && !b.selection && sameAnchor(b.message, anchor));
}

/** Where an agent reply (a turn starting with `first`) is anchored: its first message. */
export function turnAnchor(first: { timestamp: number }): MessageAnchor {
  return { role: "assistant", timestamp: first.timestamp };
}

/** A message's text as bookmarks see it (user messages without their `Attached file:` lines). */
export function anchorText(m: ChatMessage): string | null {
  if (m.role !== "user" && m.role !== "assistant") return null;
  const text = messageText(m);
  return m.role === "user" ? parseAttachedFiles(text).text : text;
}

/** The bookmarked text in a loaded transcript (`null`: not loaded / gone). */
export function loadedBookmarkText(bookmark: Bookmark): string | null {
  if (bookmark.selection) return bookmark.selection;
  const messages = getChatSession(bookmark.sessionId).transcript.value.messages;
  return anchoredText(
    messages.map((m) => ({ role: m.role, timestamp: m.timestamp, text: anchorText(m) })),
    bookmark.message,
  );
}

/**
 * The bookmarked text for Copy / Reference: the loaded transcript's, else the server's (the
 * message may be in an older page), else the excerpt saved with the bookmark.
 */
export async function bookmarkText(bookmark: Bookmark): Promise<string> {
  const loaded = loadedBookmarkText(bookmark);
  if (loaded) return loaded;
  try {
    const { text } = await apiFor(envIdOf(bookmark)).getBookmarkContent(bookmark.id);
    if (text) return text;
  } catch {
    /* offline: the excerpt will do */
  }
  return bookmark.excerpt;
}

/** Tag an item from an environment's server (untagged = local, like `folder-actions.ts`). */
function tagged<T extends { environmentId?: string }>(item: T, envId: string | undefined): T {
  return envId && connectionFor(envId) && item.environmentId !== envId ? { ...item, environmentId: envId } : item;
}

/** Bookmark a message (or a passage of it, `selection`). Null (and a toast) on failure. */
export async function addBookmark(sessionId: string, anchor: MessageAnchor, text: string, opts: { selection?: string } = {}): Promise<Bookmark | null> {
  try {
    const bookmark = tagged(await apiForSession(sessionId).createBookmark({ sessionId, message: anchor, text, ...(opts.selection ? { selection: opts.selection } : {}) }), envIdOfSession(sessionId));
    bookmarks.value = upsert(bookmarks.value, bookmark);
    return bookmark;
  } catch (err) {
    notify("error", `Could not add the bookmark: ${(err as Error).message}`);
    return null;
  }
}

/** Remove a bookmark (shown gone right away; back on failure). */
export async function removeBookmark(id: string): Promise<boolean> {
  const before = bookmarks.value.find((b) => b.id === id);
  if (!before) return false;
  bookmarks.value = bookmarks.value.filter((b) => b.id !== id);
  try {
    await apiFor(envIdOf(before)).deleteBookmark(id);
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return true;
    bookmarks.value = upsert(bookmarks.value, before);
    notify("error", `Could not remove the bookmark: ${(err as Error).message}`);
    return false;
  }
}

/** Bookmark the message, or remove its bookmark. Resolves to what happened (`null`: failed). */
export async function toggleBookmark(sessionId: string, anchor: MessageAnchor, text: string): Promise<"added" | "removed" | null> {
  const existing = messageBookmark(sessionId, anchor);
  if (existing) return (await removeBookmark(existing.id)) ? "removed" : null;
  return (await addBookmark(sessionId, anchor, text)) ? "added" : null;
}

/** Rename (`null` / blank: back to the automatic label). */
export async function renameBookmark(id: string, label: string | null): Promise<boolean> {
  const before = bookmarks.value.find((b) => b.id === id);
  if (!before) return false;
  const clean = label?.trim() || null;
  if (clean) bookmarks.value = upsert(bookmarks.value, { ...before, label: clean, labelSource: "user" });
  try {
    const next = await apiFor(envIdOf(before)).updateBookmark(id, { label: clean });
    bookmarks.value = upsert(bookmarks.value, tagged(next, before.environmentId));
    return true;
  } catch (err) {
    bookmarks.value = upsert(bookmarks.value, before);
    notify("error", `Could not rename the bookmark: ${(err as Error).message}`);
    return false;
  }
}

/**
 * The latest agent reply of a transcript: the anchor of its first message (the turn the last
 * assistant message belongs to; side questions don't split turns) and its text. `null`: no reply.
 */
export function latestReply(messages: readonly ChatMessage[]): { anchor: MessageAnchor; text: string } | null {
  let first: ChatMessage | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant") first = m;
    else if (m.role === "side") continue;
    else if (first) break;
  }
  if (!first) return null;
  const anchor = turnAnchor(first);
  const text = anchoredText(
    messages.map((m) => ({ role: m.role, timestamp: m.timestamp, text: anchorText(m) })),
    anchor,
  );
  return { anchor, text: text ?? "" };
}

/** ⌘D: bookmark the session's latest agent reply, or remove its bookmark (with a toast). */
export async function toggleLatestReplyBookmark(sessionId: string): Promise<"added" | "removed" | null> {
  const reply = latestReply(getChatSession(sessionId).transcript.value.messages);
  if (!reply) {
    notify("info", "No agent reply to bookmark yet");
    return null;
  }
  const result = await toggleBookmark(sessionId, reply.anchor, reply.text);
  if (result === "added") notify("info", "Bookmarked the latest reply");
  else if (result === "removed") notify("info", "Removed the bookmark");
  return result;
}
