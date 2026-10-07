/**
 * What a bookmark list does with a bookmark (I-203), shared by the desktop's header popover and
 * the iPhone's sheet: jump to the message (jump-to-message.ts; the caller opens the right chat
 * tab), copy it as Markdown, or reference it in a composer (references.ts). The text comes from
 * the loaded transcript, else the server (`bookmarkText`).
 */
import type { Bookmark } from "@glade/protocol";
import { bookmarkText } from "@glade/app-core/state/bookmarks";
import { notify } from "@glade/app-core/state/toasts";
import { focusComposer } from "./composer-prefill";
import { requestJump } from "./jump-to-message";
import { addReference } from "./references";

/** Scroll the bookmarked message into view (and flash it) once its chat shows it. */
export function jumpToBookmark(bookmark: Bookmark): void {
  requestJump(bookmark.sessionId, bookmark.message);
}

/** Copy the bookmarked message (or passage) as Markdown. */
export async function copyBookmark(bookmark: Bookmark): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(await bookmarkText(bookmark));
    notify("info", "Copied");
    return true;
  } catch (err) {
    notify("error", `Could not copy: ${(err as Error).message}`);
    return false;
  }
}

/** Put the bookmarked message into session `intoSessionId`'s composer as a reference chip, and focus it. */
export async function referenceBookmark(bookmark: Bookmark, intoSessionId: string): Promise<void> {
  const text = await bookmarkText(bookmark);
  addReference(intoSessionId, { id: bookmark.id, label: bookmark.label, message: bookmark.message, text, ...(bookmark.selection ? { passage: true } : {}) });
  focusComposer(intoSessionId);
}
