/**
 * Bookmarks (I-203): messages the user wants to get back to, per chat, stored per environment on
 * its server like folders and pins, synced to every client (shell scope: `bookmark_upsert` /
 * `bookmark_removed`, `ShellSnapshot.bookmarks`).
 *
 * A bookmark points at a message by {@link MessageAnchor} (role + timestamp), never by message id:
 * harness ids are positional and change after compaction and reloads. An agent bookmark points at
 * the first message of the agent's reply (a "turn": every assistant message between two user
 * messages); its content is the turn's text. A user bookmark points at that user message.
 *
 * Bookmarks go with their chat: deleting a session (tab) or a workspace deletes its bookmarks.
 *
 *   GET    /api/bookmarks[?workspaceId=|?sessionId=]  → Bookmark[] (newest first)
 *   POST   /api/bookmarks                 CreateBookmarkRequest → Bookmark (the same anchor again: the existing one)
 *   PATCH  /api/bookmarks/:id             UpdateBookmarkRequest → Bookmark
 *   DELETE /api/bookmarks/:id             → 204
 *   GET    /api/bookmarks/:id/content     → BookmarkContent (the message's text now, for Copy / Reference)
 */
import type { MessageAnchor } from "./search.js";

export interface Bookmark {
  /** ULID. */
  id: string;
  /** The session (tab or sub-agent) the message is in. */
  sessionId: string;
  /** Its workspace (the sidebar row), for listing a chat's bookmarks and opening it. */
  workspaceId: string;
  /** The message: a user message, or the first message of an agent reply. */
  message: MessageAnchor;
  /** Shown in lists: the message's first heading / first line, or the user's own name. */
  label: string;
  /** `auto`: derived from the text (renaming makes it `user`; clearing the name goes back to auto). */
  labelSource: "auto" | "user";
  /** The start of the message's text when it was bookmarked (plain, one paragraph; lists, search, fallback). */
  excerpt: string;
  /** "Bookmark Selection": the passage the user selected (its text), instead of the whole message. */
  selection?: string;
  createdAt: number;
  /** The environment (server) it's stored on; clients tag it like projects (I-123). */
  environmentId?: string;
}

/** `POST /api/bookmarks`. */
export interface CreateBookmarkRequest {
  sessionId: string;
  message: MessageAnchor;
  /** The message's text as the client shows it (Markdown); the label and excerpt come from it. */
  text: string;
  /** A name instead of the automatic one. */
  label?: string;
  /** Bookmark a selected passage of the message (its text). */
  selection?: string;
}

/** `PATCH /api/bookmarks/:id`: rename (`null` or blank: back to the automatic label). */
export interface UpdateBookmarkRequest {
  label?: string | null;
}

/** `GET /api/bookmarks/:id/content`: the bookmarked message's text as stored now. */
export interface BookmarkContent {
  /** The message's (or reply's) text; the selection for selection bookmarks; `null` when the message is gone. */
  text: string | null;
}

/** Longest label accepted (longer names are cut). */
export const MAX_BOOKMARK_LABEL = 120;
/** Automatic labels are cut to this many characters. */
export const AUTO_LABEL_CHARS = 80;
/** Excerpts are cut to this many characters. */
export const BOOKMARK_EXCERPT_CHARS = 280;
/** Longest selection kept for a selection bookmark. */
export const MAX_BOOKMARK_SELECTION = 4000;

/** Same message: role and timestamp. */
export function sameAnchor(a: MessageAnchor, b: MessageAnchor): boolean {
  return a.role === b.role && a.timestamp === b.timestamp;
}

/** Newest first (ties: id). */
export function compareBookmarks(a: Bookmark, b: Bookmark): number {
  return b.createdAt - a.createdAt || b.id.localeCompare(a.id);
}

/** Bookmarks in transcript order (the message's time; ties: newest bookmark first). */
export function compareBookmarksByMessage(a: Bookmark, b: Bookmark): number {
  return a.message.timestamp - b.message.timestamp || compareBookmarks(a, b);
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max - 1);
  const space = slice.lastIndexOf(" ");
  return `${(space > max * 0.6 ? slice.slice(0, space) : slice).replace(/[\s,.;:–—-]+$/, "")}…`;
}

/** One line of Markdown as plain text (emphasis, links, inline code and list/quote markers dropped). */
export function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The lines of a message outside fenced code blocks (fence lines dropped). */
function proseLines(text: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (fence === null) fence = m[1]![0]!;
      else if (m[1]![0] === fence) fence = null;
      continue;
    }
    if (fence === null) out.push(line);
  }
  return out;
}

/**
 * The automatic label: the message's first Markdown heading, else its first non-empty line (as
 * plain text), cut to {@link AUTO_LABEL_CHARS}. Code-only messages use their first code line.
 */
export function bookmarkLabel(text: string): string {
  const lines = proseLines(text);
  const isRule = (l: string) => /^\s*([-*_]\s*){3,}$/.test(l) || /^\s*\|?[\s:|-]+\|?\s*$/.test(l);
  const heading = lines.find((l) => /^\s{0,3}#{1,6}\s+\S/.test(l));
  const first = heading ?? lines.find((l) => !isRule(l) && plainLine(l) !== "");
  // Table rows read as their cells.
  let line = first === undefined ? "" : plainLine(first.replace(/\|/g, " "));
  if (!line) line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^(`{3,}|~{3,})/.test(l)) ?? "";
  return cut(line, AUTO_LABEL_CHARS) || "Message";
}

/** The excerpt: the message's prose as one plain paragraph, cut to {@link BOOKMARK_EXCERPT_CHARS}. */
export function bookmarkExcerpt(text: string): string {
  const prose = proseLines(text).map(plainLine).filter(Boolean).join(" ");
  return cut(prose || text.replace(/\s+/g, " ").trim(), BOOKMARK_EXCERPT_CHARS);
}

/** What anchor resolution needs of a message (`text`: its user/assistant text, `null` for none). */
export interface AnchorMessage {
  role: string;
  timestamp: number;
  text: string | null;
}

/**
 * Find a bookmarked message in a session's messages (in order) and return its text: a user
 * message's own text, or for an agent reply every assistant text from the anchored message to the
 * end of its turn (the next user, shell or notice message; side questions don't end it). Matching
 * is by role + timestamp only, so it survives id changes (reloads, compaction); on a timestamp tie
 * the first message with text wins. `null`: no message has the anchor (gone, or not loaded) or the
 * reply has no text.
 */
export function anchoredText(messages: readonly AnchorMessage[], anchor: MessageAnchor): string | null {
  let start = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== anchor.role || m.timestamp !== anchor.timestamp) continue;
    if (start === -1) start = i;
    if (m.text?.trim()) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  if (anchor.role === "user") return messages[start]!.text?.trim() || null;
  const parts: string[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "user" || m.role === "shell" || m.role === "notice") break;
    if (m.role === "assistant" && m.text?.trim()) parts.push(m.text.trim());
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** A label as typed: trimmed, cut to {@link MAX_BOOKMARK_LABEL}; blank → `null` (use the automatic one). */
export function cleanBookmarkLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.replace(/\s+/g, " ").trim();
  return label ? label.slice(0, MAX_BOOKMARK_LABEL) : null;
}
