/**
 * A list of chat rows that shows the first `limit` and a "Show more" / "Show less" toggle.
 * The selected chat is always visible (the list expands if it's beyond the limit). Pinned chats
 * come first (see `workspacesForProject`), can be dragged to reorder among themselves, and are set
 * off from the rest by a subtle divider.
 *
 * Folders (I-165): every row can also be dragged onto a folder of its list (a top-level folder
 * for standalone chats, a folder of the chat's project otherwise), or out of its folder onto the
 * project row or the list outside the folders (`dropKindOf`, `useSortable`'s `into`).
 */
import { useState } from "preact/hooks";
import type { WorkspaceSummary } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { SidebarList, sidebarClass, type SidebarIndent } from "@glade/app-core/ui";
import { reorderPinnedWorkspaces } from "@glade/app-core/state/actions";
import { moveWorkspaceToFolder } from "@glade/app-core/state/folder-actions";
import { envIdOf, folderOfWorkspace, foldersById, workspacesById, workspacesForProject } from "@glade/app-core/state/store";
import { ChatRow } from "./ChatRow";
import { DropLine } from "./DropLine";
import { useSortable, type DropInto } from "./useSortable";

export interface ChatListProps {
  /** Sorted pinned-first (`workspacesForProject`). */
  chats: WorkspaceSummary[];
  /** The list's project id, or null for standalone chats (scopes pinned reordering). */
  listId: string | null;
  /** The folder these chats are in (I-165), when it's a folder's list. */
  folderId?: string | null;
  selectedChatId: string | null;
  limit: number;
  /** Indent level of the chat titles (0 standalone, 1 inside a project = the project name). */
  indent?: SidebarIndent;
  emptyLabel?: string;
  onRemoved?: (chat: WorkspaceSummary) => void;
}

/** How many chats to render: all when expanded or the selection is past the limit. */
export function visibleChatCount(chats: WorkspaceSummary[], limit: number, expanded: boolean, selectedChatId: string | null): number {
  if (expanded) return chats.length;
  const selectedIdx = selectedChatId ? chats.findIndex((c) => c.id === selectedChatId) : -1;
  return Math.min(chats.length, Math.max(limit, selectedIdx + 1));
}

/** Drag kind of a list's chats (`data-drop-accept` of the folders that take them). */
export const dropKindOf = (projectId: string | null): string => (projectId ? `chat:${projectId}` : "chat:standalone");

/** Folder drops for a list's chats: any fitting folder of the same environment, or "" (out). */
export function chatDropInto(projectId: string | null): DropInto {
  return {
    kind: dropKindOf(projectId),
    canDrop: (id, target) => {
      const chat = workspacesById.value.get(id);
      if (!chat) return false;
      const current = folderOfWorkspace(chat);
      if (target === "") return current !== null;
      const folder = foldersById.value.get(target);
      return !!folder && folder.id !== current && folder.projectId === chat.projectId && envIdOf(folder) === envIdOf(chat);
    },
    onDrop: (id, target) => void moveWorkspaceToFolder(id, target || null),
  };
}

export function ChatList({ chats, listId, folderId = null, selectedChatId, limit, indent = 0, emptyLabel, onRemoved }: ChatListProps) {
  const [expanded, setExpanded] = useState(false);
  const count = visibleChatCount(chats, limit, expanded, selectedChatId);
  const pinnedIds = chats.filter((c) => c.pinned).map((c) => c.id);
  // The server orders every pinned chat of the list (project / standalone), folders or not.
  const allPinnedIds = folderId ? workspacesForProject(listId).filter((c) => c.pinned).map((c) => c.id) : pinnedIds;
  const listKey = `${listId ?? "standalone"}${folderId ? `:${folderId}` : ""}`;
  const into = chatDropInto(listId);
  const pinSort = useSortable({
    group: `pins:${listKey}`,
    ids: allPinnedIds,
    onReorder: (ids) => void reorderPinnedWorkspaces(listId, ids),
    reorder: pinnedIds.length >= 2,
    into,
  });
  // Unpinned chats only move into / out of folders.
  const moveSort = useSortable({ group: `chats:${listKey}`, ids: [], onReorder: () => {}, reorder: false, into });
  const visible = chats.slice(0, count);
  const visiblePinned = visible.filter((c) => c.pinned).length;
  if (chats.length === 0 && emptyLabel) {
    return <div class={cn("flex items-center text-fg-subtle", sidebarClass.row, sidebarClass.inset[indent])}>{emptyLabel}</div>;
  }
  return (
    <SidebarList role="list">
      {visible.map((chat, i) => {
        const sort = chat.pinned ? pinSort.bind(chat.id, i, visiblePinned) : moveSort.bind(chat.id, i, visible.length);
        return (
          <div
            role="listitem"
            key={chat.id}
            {...(chat.pinned ? sort.item : {})}
            {...sort.handle}
            class={cn("relative", sort.dragging && "opacity-40")}
          >
            <DropLine edge={chat.pinned ? sort.dropEdge : null} indent={indent} />
            <ChatRow
              chat={chat}
              selected={chat.id === selectedChatId}
              indent={indent}
              onRemoved={onRemoved}
              pinPosition={chat.pinned && pinnedIds.length > 1 ? { first: i === 0, last: i === pinnedIds.length - 1 } : undefined}
            />
            {i === visiblePinned - 1 && i < visible.length - 1 && (
              <div aria-hidden data-pinned-divider class={cn("absolute right-2 -bottom-[1.5px] h-px bg-separator", sidebarClass.lineStart[indent])} />
            )}
          </div>
        );
      })}
      {chats.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          class={cn("flex h-6 items-center rounded-[6px] text-left text-[0.92rem] text-fg-muted hover:text-fg", sidebarClass.inset[indent])}
        >
          {expanded ? "Show less" : `Show more (${chats.length - count})`}
        </button>
      )}
    </SidebarList>
  );
}
