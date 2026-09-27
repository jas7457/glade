/**
 * One chat in the sidebar: title, and on the right the pin plus the status (spinner / unread
 * dot / needs-input) when not idle, else the age. On hover (or while the menu is open) the right
 * side is replaced by a "…" menu button; the same menu opens on right-click: Rename, Pin,
 * Move Up/Down (pinned chats), Mark as Read, Delete.
 */
import { useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { MoreHorizontal, Pin } from "lucide-preact";
import type { WorkspaceSummary } from "@glade/protocol";
import { chatPath } from "@/app/routes";
import { ContextMenu, IconButton, Menu, MenuItem, MenuSeparator, SidebarItem, StatusIndicator, confirm, type SidebarIndent } from "@/ui";
import { deleteWorkspace, markWorkspaceRead, movePinnedWorkspace, renameWorkspace, setWorkspacePinned } from "@/state/actions";
import { InlineRename } from "./InlineRename";
import { formatRelativeTime } from "./time";

export interface ChatRowProps {
  chat: WorkspaceSummary;
  selected: boolean;
  indent?: SidebarIndent;
  /** Called after the chat was deleted while selected (navigate elsewhere). */
  onRemoved?: (chat: WorkspaceSummary) => void;
  /** Position in its pinned group (pinned chats in a group of 2+); enables Move Up / Move Down. */
  pinPosition?: { first: boolean; last: boolean };
}

export async function confirmDeleteChat(chat: WorkspaceSummary): Promise<boolean> {
  const ok = await confirm({
    title: "Delete chat?",
    subject: chat.title || "Untitled",
    message: "will be permanently deleted. This can't be undone.",
    confirmLabel: "Delete",
    destructive: true,
  });
  return ok && deleteWorkspace(chat.id);
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
        onSelect={() => {
          renaming.current = true;
          setEditing(true);
        }}
      >
        Rename
      </MenuItem>
      <MenuItem onSelect={() => void setWorkspacePinned(chat.id, !chat.pinned)}>{chat.pinned ? "Unpin" : "Pin"}</MenuItem>
      {pinPosition && (
        <>
          <MenuItem disabled={pinPosition.first} onSelect={() => void movePinnedWorkspace(chat.id, -1)}>
            Move Up
          </MenuItem>
          <MenuItem disabled={pinPosition.last} onSelect={() => void movePinnedWorkspace(chat.id, 1)}>
            Move Down
          </MenuItem>
        </>
      )}
      {chat.status === "unread" && <MenuItem onSelect={() => void markWorkspaceRead(chat.id)}>Mark as Read</MenuItem>}
      <MenuSeparator />
      <MenuItem destructive onSelect={() => void remove()}>
        Delete…
      </MenuItem>
    </>
  );

  const trailing = (
    <>
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
