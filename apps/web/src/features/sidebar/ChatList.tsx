/**
 * A chat list in the sidebar (I-202): a project's chats, or the standalone Chats section. Pinned
 * chats come first (dragged to reorder among themselves, set off by a subtle divider), then one
 * manual order of chats and folders mixed (e.g. chat, folder, chat); each folder shows its pinned
 * chats, then its others. The first `limit` entries show, with "Show more" / "Show less" (the
 * selected chat is always visible).
 *
 * Dragging (`useChatTree`): any unpinned chat or folder goes to any position of the list, chats
 * into / out of / within folders, the insertion line indented to where it lands; onto a folder's
 * row puts a chat at the folder's top (pinned chats too). Nothing leaves the list: outside it
 * (`dropAreaProps`) a drag shows "not allowed". A closed folder opens after a short hover.
 */
import { useState } from "preact/hooks";
import type { Folder, WorkspaceSummary } from "@glade/protocol";
import { cn } from "@glade/app-core/lib/cn";
import { SidebarList, sidebarClass, type SidebarIndent } from "@glade/app-core/ui";
import { reorderPinnedWorkspaces } from "@glade/app-core/state/actions";
import { moveWorkspaceToFolder, reorderChatList } from "@glade/app-core/state/folder-actions";
import { chatListOf, envIdOf, folderOfWorkspace, foldersById, workspacesById, workspacesForProject } from "@glade/app-core/state/store";
import { closedProjects, setProjectOpen } from "@glade/app-core/state/ui";
import { ChatRow } from "./ChatRow";
import { DropLine } from "./DropLine";
import { FolderGroup } from "./FolderGroup";
import { visibleEntryCount } from "./reorder";
import { useChatTree, useSortable, type DropInto, type TreeBinding } from "./useSortable";

export interface ChatListProps {
  /** The list's project, or null for the standalone Chats section. */
  projectId: string | null;
  selectedChatId: string | null;
  limit: number;
  /** Indent of the list's top-level chat titles (0 standalone, 1 inside a project = the project name). */
  indent?: 0 | 1;
  emptyLabel?: string;
  onRemoved?: (chat: WorkspaceSummary) => void;
}

/** The drag area of a list (its own project, or the Chats section). */
export const listArea = (projectId: string | null): string => `list:${projectId ?? "standalone"}`;

/** Drag kind of a list's chats (`data-drop-accept` of the folders that take them). */
export const dropKindOf = (projectId: string | null): string => (projectId ? `chat:${projectId}` : "chat:standalone");

/** Folder-row drops for a list's chats: a folder of the same list and environment it isn't in yet. */
export function chatDropInto(projectId: string | null): DropInto {
  return {
    kind: dropKindOf(projectId),
    band: true,
    canDrop: (id, target) => {
      const chat = workspacesById.value.get(id);
      const folder = foldersById.value.get(target);
      return !!chat && !!folder && folder.id !== folderOfWorkspace(chat) && folder.projectId === chat.projectId && envIdOf(folder) === envIdOf(chat);
    },
    onDrop: (id, target) => void moveWorkspaceToFolder(id, target),
  };
}

/** Open a closed folder the pointer rests on while dragging. */
const openFolder = (id: string) => {
  if (closedProjects.value.has(id)) setProjectOpen(id, true);
};

export function ChatList({ projectId, selectedChatId, limit, indent = 0, emptyLabel, onRemoved }: ChatListProps) {
  const [expanded, setExpanded] = useState(false);
  const view = chatListOf(projectId);
  const listKey = projectId ?? "standalone";
  const into = chatDropInto(projectId);
  const area = listArea(projectId);
  // The server orders every pinned chat of the list (in folders or not): reorders keep the others.
  const allPinnedIds = workspacesForProject(projectId)
    .filter((c) => c.pinned)
    .map((c) => c.id);
  const pinSort = useSortable({
    group: `pins:${listKey}`,
    ids: allPinnedIds,
    onReorder: (ids) => void reorderPinnedWorkspaces(projectId, ids),
    reorder: view.pinned.length >= 2,
    into,
    area,
    onHoverTarget: openFolder,
  });
  const tree = useChatTree({
    group: `tree:${listKey}`,
    area,
    into,
    onHoverTarget: openFolder,
    onDrop: (_id, drop) => void reorderChatList(projectId, drop.parent, drop.order),
  });

  const closed = closedProjects.value;
  const holds = view.entries.map((e) => (id: string) => (e.kind === "chat" ? e.chat.id === id : e.chats.some((c) => c.id === id)));
  const count = visibleEntryCount(holds, limit, expanded, selectedChatId);
  const entries = view.entries.slice(0, count);
  if (view.pinned.length === 0 && view.entries.length === 0 && emptyLabel) {
    return <div class={cn("flex items-center text-fg-subtle", sidebarClass.row, sidebarClass.inset[indent])}>{emptyLabel}</div>;
  }
  const rowProps = { selectedChatId, onRemoved };
  return (
    <SidebarList role="list">
      {view.pinned.map((chat, i) => {
        const sort = pinSort.bind(chat.id, i, view.pinned.length);
        return (
          <ChatItem
            key={chat.id}
            chat={chat}
            indent={indent}
            binding={{ item: sort.item, handle: sort.handle, dragging: sort.dragging, drop: sort.dropEdge ? { edge: sort.dropEdge, depth: 0 } : null, shifted: sort.shifted }}
            divider={i === view.pinned.length - 1 && entries.length > 0}
            {...rowProps}
          />
        );
      })}
      {entries.map((e) => {
        if (e.kind === "chat") return <ChatItem key={e.chat.id} chat={e.chat} indent={indent} binding={tree.bind(e.chat.id, "chat")} {...rowProps} />;
        const open = !closed.has(e.folder.id);
        const folderTree = tree.bind(e.folder.id, "folder", null, open);
        return (
          <FolderGroup
            key={e.folder.id}
            folder={e.folder}
            indent={indent}
            statuses={e.chats.map((c) => c.status)}
            accept={dropKindOf(projectId)}
            tree={folderTree}
            contentsLabel="Its chats"
          >
            <FolderChats
              folder={e.folder}
              chats={e.chats}
              indent={(indent + 1) as SidebarIndent}
              bind={tree.bind}
              folderShifted={folderTree.shifted}
              into={into}
              area={area}
              {...rowProps}
            />
          </FolderGroup>
        );
      })}
      {view.entries.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          class={cn(
            "flex h-6 items-center rounded-[6px] text-left text-[0.92rem] text-fg-muted hover:text-fg",
            sidebarClass.inset[indent],
            sidebarClass.dropShiftTransition,
            tree.gapOpen && sidebarClass.dropShift,
          )}
        >
          {expanded ? "Show less" : `Show more (${view.entries.length - count})`}
        </button>
      )}
    </SidebarList>
  );
}

interface FolderChatsProps {
  folder: Folder;
  /** Sorted pinned first (`chatListOf`). */
  chats: WorkspaceSummary[];
  indent: SidebarIndent;
  bind: (id: string, kind: "chat" | "folder", parent?: string | null, open?: boolean) => TreeBinding;
  /** The folder's row slides down for a drop above it: its pinned chats (not tree rows) follow. */
  folderShifted: boolean;
  into: DropInto;
  area: string;
  selectedChatId: string | null;
  onRemoved?: (chat: WorkspaceSummary) => void;
}

/** A folder's chats: its pinned ones (reordered among themselves), then the rest in the tree. */
function FolderChats({ folder, chats, indent, bind, folderShifted, into, area, selectedChatId, onRemoved }: FolderChatsProps) {
  const pinned = chats.filter((c) => c.pinned);
  const allPinnedIds = workspacesForProject(folder.projectId)
    .filter((c) => c.pinned)
    .map((c) => c.id);
  const pinSort = useSortable({
    group: `pins:${folder.id}`,
    ids: allPinnedIds,
    onReorder: (ids) => void reorderPinnedWorkspaces(folder.projectId, ids),
    reorder: pinned.length >= 2,
    into,
    area,
    onHoverTarget: openFolder,
  });
  if (chats.length === 0) {
    return (
      <div class={cn("flex items-center text-fg-subtle", sidebarClass.row, sidebarClass.inset[indent], sidebarClass.dropShiftTransition, folderShifted && sidebarClass.dropShift)}>
        No chats
      </div>
    );
  }
  return (
    <>
      {chats.map((chat, i) => {
        if (!chat.pinned) return <ChatItem key={chat.id} chat={chat} indent={indent} binding={bind(chat.id, "chat", folder.id)} selectedChatId={selectedChatId} onRemoved={onRemoved} />;
        const sort = pinSort.bind(chat.id, i, pinned.length);
        return (
          <ChatItem
            key={chat.id}
            chat={chat}
            indent={indent}
            binding={{ item: sort.item, handle: sort.handle, dragging: sort.dragging, drop: sort.dropEdge ? { edge: sort.dropEdge, depth: 0 } : null, shifted: sort.shifted || folderShifted }}
            divider={i === pinned.length - 1 && i < chats.length - 1}
            selectedChatId={selectedChatId}
            onRemoved={onRemoved}
          />
        );
      })}
    </>
  );
}

interface ChatItemProps {
  chat: WorkspaceSummary;
  /** Indent of the chat's title; a drop line at depth 1 is one level deeper. */
  indent: SidebarIndent;
  binding: Pick<TreeBinding, "handle" | "dragging" | "drop" | "shifted"> & { item: Record<string, string> };
  /** Draw the pinned/unpinned divider under it. */
  divider?: boolean;
  selectedChatId: string | null;
  onRemoved?: (chat: WorkspaceSummary) => void;
}

/** One draggable chat row: the measured element, its insertion line and the gap animation. */
function ChatItem({ chat, indent, binding, divider, selectedChatId, onRemoved }: ChatItemProps) {
  return (
    <div
      role="listitem"
      {...binding.item}
      {...binding.handle}
      class={cn("relative", sidebarClass.dropShiftTransition, binding.shifted && sidebarClass.dropShift, binding.dragging && "opacity-40")}
    >
      <DropLine edge={binding.drop?.edge ?? null} indent={binding.drop ? depthIndent(indent, binding.drop.depth, binding.item) : indent} />
      <ChatRow chat={chat} selected={chat.id === selectedChatId} indent={indent} onRemoved={onRemoved} />
      {divider && <div aria-hidden data-pinned-divider class={cn("absolute right-2 -bottom-[1.5px] h-px bg-separator", sidebarClass.lineStart[indent])} />}
    </div>
  );
}

/**
 * The indent of an insertion line on a row: the depth it lands at, measured from the row's own
 * level (a row inside a folder is one level deeper than the list's top level).
 */
function depthIndent(rowIndent: SidebarIndent, depth: 0 | 1, item: Record<string, string>): SidebarIndent {
  const inFolder = item["data-tree-parent"] !== undefined;
  const top = inFolder ? rowIndent - 1 : rowIndent;
  return Math.max(0, Math.min(3, top + depth)) as SidebarIndent;
}
