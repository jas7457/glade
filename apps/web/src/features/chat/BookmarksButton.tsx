/**
 * The chat header's bookmarks (I-203): a toolbar button with the chat's bookmark count that opens
 * its list (also ⌘⇧D, `bookmarkListOpen`). A row shows the label, the message's time and its
 * first line; clicking it (or ↩) opens the right tab and scrolls the message into view with a
 * flash. Per row: Reference (a chip in the composer, sent as a short quote), Copy (Markdown),
 * Rename (right-click; an empty name goes back to the automatic one), Remove (also ⌫). ⌘C copies
 * the highlighted row.
 */
import { useState } from "preact/hooks";
import { Bookmark as BookmarkIcon, Copy, MessageSquareQuote, Pencil, TextSelect, Trash2 } from "lucide-preact";
import type { Bookmark, WorkspaceSummary } from "@glade/protocol";
import { bookmarkListOpen, bookmarksOfWorkspace, removeBookmark, renameBookmark } from "@glade/app-core/state/bookmarks";
import { bookmarks, sessionsById } from "@glade/app-core/state/store";
import { copyBookmark, jumpToBookmark, referenceBookmark } from "@glade/app-core/features/chat/bookmark-actions";
import { formatMessageDateTime, formatMessageTime, dayLabel } from "@glade/app-core/features/chat/message-time";
import { ListPopover, ToolbarToggle, formatShortcut, type ListPopoverItem } from "@glade/app-core/ui";
import { BOOKMARK_SHORTCUTS } from "@/app/shortcuts";
import { focusMainTab, openSubagent, type Navigate } from "@/features/workspace/layout-actions";

/** "14:32" today, "Yesterday 14:32", else "Thu 25 Sep 14:32". */
export function bookmarkTime(ts: number, now = Date.now()): string {
  const day = dayLabel(ts, now);
  const time = formatMessageTime(ts);
  return day === "Today" ? time : `${day} ${time}`;
}

/** Open the tab holding the bookmark's message (a sub-agent: its parent's tab and the pane), then jump. */
export function openBookmark(bookmark: Bookmark, navigate: Navigate): void {
  const session = sessionsById.value.get(bookmark.sessionId);
  jumpToBookmark(bookmark);
  if (!session) return;
  if (session.kind === "subagent" && session.parentSessionId) {
    focusMainTab(bookmark.workspaceId, session.parentSessionId, navigate);
    openSubagent(bookmark.workspaceId, session.parentSessionId, session.id);
  } else {
    focusMainTab(bookmark.workspaceId, session.id, navigate);
  }
}

export function BookmarksButton({ workspace, sessionId, navigate }: { workspace: WorkspaceSummary; sessionId: string; navigate: Navigate }) {
  const list = bookmarksOfWorkspace(workspace.id, bookmarks.value);
  const open = bookmarkListOpen.value === workspace.id;
  const [editing, setEditing] = useState<string | null>(null);
  const setOpen = (next: boolean) => {
    bookmarkListOpen.value = next ? workspace.id : null;
    if (!next) setEditing(null);
  };
  const byId = new Map(list.map((b) => [b.id, b]));

  const items: ListPopoverItem[] = list.map((b) => ({
    id: b.id,
    label: b.label,
    icon: b.selection ? <TextSelect /> : <BookmarkIcon />,
    meta: <time title={formatMessageDateTime(b.message.timestamp)}>{bookmarkTime(b.message.timestamp)}</time>,
    detail: b.excerpt && b.excerpt !== b.label ? b.excerpt : undefined,
    actions: [
      { id: "reference", label: "Reference in Message", icon: <MessageSquareQuote /> },
      { id: "copy", label: "Copy as Markdown", icon: <Copy />, shortcut: "⌘C" },
      { id: "rename", label: "Rename…", icon: <Pencil />, menuOnly: true },
      { id: "remove", label: "Remove Bookmark", icon: <Trash2 />, destructive: true, shortcut: "⌫" },
    ],
  }));

  const select = (id: string) => {
    const b = byId.get(id);
    if (!b) return;
    setOpen(false);
    openBookmark(b, navigate);
  };
  const act = (id: string, action: string) => {
    const b = byId.get(id);
    if (!b) return;
    if (action === "reference") {
      setOpen(false);
      void referenceBookmark(b, sessionId);
    } else if (action === "copy") void copyBookmark(b);
    else if (action === "rename") setEditing(id);
    else if (action === "remove") void removeBookmark(id);
  };

  const count = list.length;
  return (
    <ListPopover
      open={open}
      onOpenChange={setOpen}
      title="Bookmarks"
      hint={count ? `↩ jump · ${formatShortcut("mod+c")} copy` : undefined}
      anchor={
        <ToolbarToggle
          icon={<BookmarkIcon />}
          count={count}
          pressed={open}
          label={count ? `${count} ${count === 1 ? "bookmark" : "bookmarks"}` : "Bookmarks"}
          tooltip={`Bookmarks (${formatShortcut(BOOKMARK_SHORTCUTS["show-bookmarks"])})`}
          onClick={() => setOpen(!open)}
        />
      }
      items={items}
      onSelect={select}
      onAction={act}
      onRowKey={(e, id) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") return act(id, "copy"), true;
        if (e.key === "Backspace" || e.key === "Delete") return act(id, "remove"), true;
        return false;
      }}
      editingId={editing}
      editPlaceholder="Name (empty: automatic)"
      onEditDone={(id, value) => {
        setEditing(null);
        const b = byId.get(id);
        if (value === null || !b) return;
        if (value === "" ? b.labelSource !== "auto" : value !== b.label) void renameBookmark(id, value || null);
      }}
      empty={
        <span class="flex flex-col gap-1 px-4">
          <span>No bookmarks in this chat</span>
          <span class="text-[0.88rem] text-fg-subtle">
            Hover a message and click the bookmark, or press {formatShortcut(BOOKMARK_SHORTCUTS["bookmark-reply"])} for the latest reply.
          </span>
        </span>
      }
    />
  );
}
