/**
 * Bookmarks (I-203; types and rules in `@glade/protocol` bookmarks.ts): bookmark a message of a
 * chat, rename or remove the bookmark, and read the bookmarked message's text now (Copy,
 * Reference). Stored per environment in the store and pushed like folders (`bookmark_upsert` /
 * `bookmark_removed`; the sync hub sends them from the event rows). Deleting a session or
 * workspace deletes its bookmarks in the store's own transaction.
 */
import {
  MAX_BOOKMARK_SELECTION,
  anchoredText,
  bookmarkExcerpt,
  bookmarkLabel,
  cleanBookmarkLabel,
  compareBookmarks,
  messageText,
  parseAttachedFiles,
  sameAnchor,
  type Bookmark,
  type BookmarkContent,
  type CreateBookmarkRequest,
  type MessageAnchor,
  type UpdateBookmarkRequest,
} from "@glade/protocol";
import { ulid } from "../../store/db/ids.js";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";
import type { Records } from "./records.js";

export class Bookmarks {
  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
  ) {}

  private get store() {
    return this.ctx.store;
  }

  /** Every bookmark (or a workspace's / session's), newest first. */
  listBookmarks(filter: { workspaceId?: string; sessionId?: string } = {}): Bookmark[] {
    return this.store
      .listBookmarks()
      .filter((b) => (filter.workspaceId === undefined || b.workspaceId === filter.workspaceId) && (filter.sessionId === undefined || b.sessionId === filter.sessionId))
      .sort(compareBookmarks);
  }

  requireBookmark(id: string): Bookmark {
    const bookmark = this.store.getBookmark(id);
    if (!bookmark) throw new HttpError(404, "Bookmark not found");
    return bookmark;
  }

  /** Bookmark a message; the same message again (and no selection) returns the existing bookmark. */
  createBookmark(req: CreateBookmarkRequest): Bookmark {
    const session = this.records.requireSession(req.sessionId);
    const message = anchorOf(req.message);
    const selection = typeof req.selection === "string" && req.selection.trim() ? req.selection.trim().slice(0, MAX_BOOKMARK_SELECTION) : undefined;
    if (!selection) {
      const existing = this.store.listBookmarks().find((b) => b.sessionId === session.id && !b.selection && sameAnchor(b.message, message));
      if (existing) return existing;
    }
    const text = typeof req.text === "string" ? req.text : "";
    const source = selection ?? text;
    const userLabel = cleanBookmarkLabel(req.label);
    const bookmark: Bookmark = {
      id: ulid(),
      sessionId: session.id,
      workspaceId: session.workspaceId,
      message,
      label: userLabel ?? bookmarkLabel(source),
      labelSource: userLabel ? "user" : "auto",
      excerpt: bookmarkExcerpt(source),
      ...(selection ? { selection } : {}),
      createdAt: Date.now(),
      environmentId: this.store.environmentId,
    };
    this.store.upsertBookmark(bookmark);
    this.ctx.broadcast({ type: "bookmark_upsert", bookmark });
    return bookmark;
  }

  /** Rename (`null` / blank: back to the automatic label, from the excerpt's message). */
  updateBookmark(id: string, req: UpdateBookmarkRequest): Bookmark {
    const bookmark = this.requireBookmark(id);
    if (req.label === undefined) return bookmark;
    const label = cleanBookmarkLabel(req.label);
    let next: Bookmark;
    if (label) next = { ...bookmark, label, labelSource: "user" };
    else {
      const text = bookmark.selection ?? this.messageText(bookmark.sessionId, bookmark.message) ?? bookmark.excerpt;
      next = { ...bookmark, label: bookmarkLabel(text), labelSource: "auto" };
    }
    this.store.upsertBookmark(next);
    this.ctx.broadcast({ type: "bookmark_upsert", bookmark: next });
    return next;
  }

  removeBookmark(id: string): void {
    this.requireBookmark(id);
    this.store.removeBookmarks([id]);
    this.ctx.broadcast({ type: "bookmark_removed", bookmarkId: id });
  }

  /** The bookmarked text now: the selection, else the message as stored (live transcript first). */
  bookmarkContent(id: string): BookmarkContent {
    const bookmark = this.requireBookmark(id);
    if (bookmark.selection) return { text: bookmark.selection };
    return { text: this.messageText(bookmark.sessionId, bookmark.message) };
  }

  private messageText(sessionId: string, anchor: MessageAnchor): string | null {
    // A running chat's newest text may not be written yet (the transcript writer batches).
    const live = this.ctx.live.get(sessionId);
    if (live) {
      const messages = live.transcript.messages.map((m) => {
        const raw = m.role === "user" || m.role === "assistant" ? messageText(m) : null;
        return { role: m.role, timestamp: m.timestamp, text: raw !== null && m.role === "user" ? parseAttachedFiles(raw).text : raw };
      });
      const text = anchoredText(messages, anchor);
      if (text !== null) return text;
    }
    return this.store.anchoredMessageText(sessionId, anchor);
  }
}

/** A valid anchor from a request (400 otherwise). */
function anchorOf(raw: unknown): MessageAnchor {
  const a = raw as Partial<MessageAnchor> | null;
  if (!a || (a.role !== "user" && a.role !== "assistant") || typeof a.timestamp !== "number" || !Number.isFinite(a.timestamp)) {
    throw new HttpError(400, "message must be { role: \"user\" | \"assistant\", timestamp: number }");
  }
  return { role: a.role, timestamp: a.timestamp };
}
