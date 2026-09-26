/**
 * One chat in the sidebar: title, running spinner / unread dot / age, and a menu (hover "…"
 * button and right-click) with Rename, Pin, Archive, Delete.
 */
import { useRef, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { Archive, MoreHorizontal, Pin } from "lucide-preact";
import type { ChatSummary } from "@pi-ui/protocol";
import { chatPath } from "@/app/routes";
import { ContextMenu, IconButton, Menu, MenuItem, MenuSeparator, SidebarItem, StatusIndicator, confirm } from "@/ui";
import { deleteChat, renameChat, setChatArchived, setChatPinned, updateChat } from "@/state/actions";
import { InlineRename } from "./InlineRename";
import { formatRelativeTime } from "./time";

export interface ChatRowProps {
  chat: ChatSummary;
  selected: boolean;
  indent?: 0 | 1;
  /** Called after the chat was deleted or archived while selected (navigate elsewhere). */
  onRemoved?: (chat: ChatSummary) => void;
}

export async function confirmDeleteChat(chat: ChatSummary): Promise<boolean> {
  const ok = await confirm({
    title: `Delete “${chat.title || "Untitled"}”?`,
    message: "The conversation will be moved to the Trash. This can't be undone from pi-ui.",
    confirmLabel: "Delete",
    destructive: true,
  });
  return ok && deleteChat(chat.id);
}

export function ChatRow({ chat, selected, indent = 0, onRemoved }: ChatRowProps) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Set when "Rename" is chosen so the closing menu doesn't steal focus from the field.
  const renaming = useRef(false);
  const onCloseAutoFocus = (e: Event) => {
    if (renaming.current) e.preventDefault();
    renaming.current = false;
  };

  const archive = async () => {
    if ((await setChatArchived(chat.id, !chat.archived)) && selected && !chat.archived) onRemoved?.(chat);
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
      <MenuItem onSelect={() => void setChatPinned(chat.id, !chat.pinned)}>{chat.pinned ? "Unpin" : "Pin"}</MenuItem>
      {chat.status === "unread" && <MenuItem onSelect={() => void updateChat(chat.id, { unread: false })}>Mark as Read</MenuItem>}
      <MenuSeparator />
      <MenuItem onSelect={() => void archive()}>{chat.archived ? "Unarchive" : "Archive"}</MenuItem>
      <MenuItem destructive onSelect={() => void remove()}>
        Delete…
      </MenuItem>
    </>
  );

  const trailing =
    chat.status !== "idle" ? (
      <StatusIndicator status={chat.status} failed={chat.lastRunFailed} />
    ) : (
    <>
      {chat.pinned && <Pin size={11} aria-label="Pinned" />}
      <span>{formatRelativeTime(chat.lastActivityAt)}</span>
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
                void renameChat(chat.id, title);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : undefined
        }
        actions={
          <>
            {!chat.archived && (
              <IconButton size="sm" label="Archive" onClick={() => void archive()}>
                <Archive />
              </IconButton>
            )}
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
