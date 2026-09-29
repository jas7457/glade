/**
 * One chat in the sidebar: title, and on the right the pin plus the status (spinner / unread
 * dot / needs-input) when not idle, else the age. On hover (or while the menu is open) the right
 * side is replaced by a "…" menu button; the same menu opens on right-click: Rename, Pin,
 * Move Up/Down (pinned chats), Move to Folder (I-165), Mark as Read / Mark as Unread (I-073: flags
 * the last open tab), Delete.
 * Chats working in their own git worktree (I-096) show a small branch glyph.
 */
import { RemoteMarker } from "@/features/environments/RemoteMarker";
import { envIdOf, folderOfWorkspace } from "@glade/app-core/state/store";
import { moveWorkspaceToFolder } from "@glade/app-core/state/folder-actions";
import { MoveToFolderMenu } from "./folder-menu";
import { useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { ArrowDown, ArrowUp, GitBranch, Mail, MailOpen, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-preact";
import type { WorkspaceSummary } from "@glade/protocol";
import { chatPath } from "@glade/app-core/app/routes";
import { ContextMenu, IconButton, Menu, MenuItem, MenuSeparator, SidebarItem, StatusIndicator, type SidebarIndent } from "@glade/app-core/ui";
import { markWorkspaceRead, markWorkspaceUnread, movePinnedWorkspace, renameWorkspace, setWorkspacePinned } from "@glade/app-core/state/actions";
import { confirmDeleteChat } from "./delete-chat";
import { InlineRename } from "./InlineRename";
import { formatRelativeTime } from "@glade/app-core/features/sidebar/time";

export interface ChatRowProps {
  chat: WorkspaceSummary;
  selected: boolean;
  indent?: SidebarIndent;
  /** Called after the chat was deleted while selected (navigate elsewhere). */
  onRemoved?: (chat: WorkspaceSummary) => void;
  /** Position in its pinned group (pinned chats in a group of 2+); enables Move Up / Move Down. */
  pinPosition?: { first: boolean; last: boolean };
}

export function ChatRow({ chat, selected, indent = 0, onRemoved, pinPosition }: ChatRowProps) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Set when "Rename" is chosen so the closing menu doesn't steal focus from the field.
  const renaming = useRef(false);
  const onCloseAutoFocus = (e: Event) => {
    if (renaming.current) e.preventDefault();
    renaming.current = false;
  };

  const remove = async () => {
    if ((await confirmDeleteChat(chat)) && selected) onRemoved?.(chat);
  };

  const items = (
    <>
      <MenuItem
        icon={<Pencil />}
        onSelect={() => {
          renaming.current = true;
          setEditing(true);
        }}
      >
        Rename
      </MenuItem>
      <MenuItem icon={chat.pinned ? <PinOff /> : <Pin />} onSelect={() => void setWorkspacePinned(chat.id, !chat.pinned)}>{chat.pinned ? "Unpin" : "Pin"}</MenuItem>
      {pinPosition && (
        <>
          <MenuItem icon={<ArrowUp />} disabled={pinPosition.first} onSelect={() => void movePinnedWorkspace(chat.id, -1)}>
            Move Up
          </MenuItem>
          <MenuItem icon={<ArrowDown />} disabled={pinPosition.last} onSelect={() => void movePinnedWorkspace(chat.id, 1)}>
            Move Down
          </MenuItem>
        </>
      )}
      <MoveToFolderMenu
        projectId={chat.projectId}
        envId={envIdOf(chat)}
        current={folderOfWorkspace(chat)}
        onMove={(folderId) => void moveWorkspaceToFolder(chat.id, folderId)}
      />
      {chat.unread ? (
        <MenuItem icon={<MailOpen />} onSelect={() => void markWorkspaceRead(chat.id)}>Mark as Read</MenuItem>
      ) : (
        <MenuItem icon={<Mail />} onSelect={() => void markWorkspaceUnread(chat.id)}>Mark as Unread</MenuItem>
      )}
      <MenuSeparator />
      <MenuItem destructive icon={<Trash2 />} onSelect={() => void remove()}>
        Delete…
      </MenuItem>
    </>
  );

  const trailing = (
    <>
      {chat.worktree && (
        <span title={`Works in a worktree on branch ${chat.worktree.branch} (from ${chat.worktree.baseRef})`} class="inline-flex">
          <GitBranch size={11} aria-label={`Worktree ${chat.worktree.branch}`} />
        </span>
      )}
      {chat.pinned && <Pin size={11} aria-label="Pinned" />}
      {chat.status !== "idle" ? (
        <StatusIndicator status={chat.status} failed={chat.lastRunFailed} />
      ) : (
        <span>{formatRelativeTime(chat.lastActivityAt)}</span>
      )}
    </>
  );

  return (
    <ContextMenu content={items} onCloseAutoFocus={onCloseAutoFocus} disabled={editing}>
      <SidebarItem
        data-chat-id={chat.id}
        label={chat.title || "Untitled"}
        title={chat.title}
        selected={selected}
        strong={chat.status === "unread" && !selected}
        indent={indent}
        onSelect={() => navigate(chatPath(chat))}
        // Standalone chats of another environment (I-123); a project's chats show it on the project.
        badge={chat.projectId === null ? <RemoteMarker envId={envIdOf(chat)} /> : undefined}
        trailing={trailing}
        actionsVisible={menuOpen}
        editor={
          editing ? (
            <InlineRename
              value={chat.title}
              aria-label="Chat title"
              onCommit={(title) => {
                setEditing(false);
                void renameWorkspace(chat.id, title);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : undefined
        }
        actions={
          <>
            <Menu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              align="start"
              onCloseAutoFocus={onCloseAutoFocus}
              trigger={
                <IconButton size="sm" label="More" tooltip={false}>
                  <MoreHorizontal />
                </IconButton>
              }
            >
              {items}
            </Menu>
          </>
        }
      />
    </ContextMenu>
  );
}
