/**
 * A list of chat rows that shows the first `limit` and a "Show more" / "Show less" toggle.
 * The selected chat is always visible (the list expands if it's beyond the limit). Pinned chats
 * come first (see `workspacesForProject`), can be dragged to reorder among themselves, and are set
 * off from the rest by a subtle divider.
 */
import { useState } from "preact/hooks";
import type { WorkspaceSummary } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { SidebarList, sidebarClass, type SidebarIndent } from "@/ui";
import { reorderPinnedWorkspaces } from "@/state/actions";
import { ChatRow } from "./ChatRow";
import { DropLine } from "./DropLine";
import { useSortable } from "./useSortable";

export interface ChatListProps {
  /** Sorted pinned-first (`workspacesForProject`). */
  chats: WorkspaceSummary[];
  /** The list's project id, or null for standalone chats (scopes pinned reordering). */
  listId: string | null;
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

export function ChatList({ chats, listId, selectedChatId, limit, indent = 0, emptyLabel, onRemoved }: ChatListProps) {
  const [expanded, setExpanded] = useState(false);
  const count = visibleChatCount(chats, limit, expanded, selectedChatId);
  const pinnedIds = chats.filter((c) => c.pinned).map((c) => c.id);
  const pinSort = useSortable({
    group: `pins:${listId ?? "standalone"}`,
    ids: pinnedIds,
    onReorder: (ids) => void reorderPinnedWorkspaces(listId, ids),
    disabled: pinnedIds.length < 2,
  });
  const visible = chats.slice(0, count);
  const visiblePinned = visible.filter((c) => c.pinned).length;
  if (chats.length === 0 && emptyLabel) {
    return <div class={cn("flex items-center text-fg-subtle", sidebarClass.row, sidebarClass.inset[indent])}>{emptyLabel}</div>;
  }
  return (
    <SidebarList role="list">
      {visible.map((chat, i) => {
        const sort = chat.pinned ? pinSort.bind(chat.id, i, visiblePinned) : undefined;
        return (
          <div
            role="listitem"
            key={chat.id}
            {...sort?.item}
            {...sort?.handle}
            class={cn("relative", sort?.dragging && "opacity-40")}
          >
            <DropLine edge={sort?.dropEdge ?? null} indent={indent} />
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
