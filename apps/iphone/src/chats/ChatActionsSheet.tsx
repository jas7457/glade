/**
 * A chat's actions on the iPhone (long-press on a row, I-164): Rename, Pin/Unpin, Move to Folder
 * (I-165), Mark as Read/Unread and Delete, as a bottom sheet (iOS has no context menus over web
 * content).
 */
import { useEffect, useState } from "preact/hooks";
import type { WorkspaceSummary } from "@glade/protocol";
import { deleteWorkspace, markWorkspaceRead, markWorkspaceUnread, renameWorkspace, setWorkspacePinned } from "@/state/actions";
import { moveWorkspaceToFolder } from "@/state/folder-actions";
import { envIdOf, folderOfWorkspace } from "@/state/store";
import { ListGroup, ListRow, PhoneButton, PhoneInput, Sheet } from "~/ui/phone";
import { MoveToFolderSheet } from "./FolderSheets";

type Mode = "menu" | "rename" | "delete" | "move";

export function ChatActionsSheet({ chat, onClose }: { chat: WorkspaceSummary | null; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("menu");
  const [title, setTitle] = useState("");
  useEffect(() => {
    setMode("menu");
    setTitle(chat?.title ?? "");
  }, [chat?.id]);
  if (!chat) return null;
  const run = (fn: () => unknown) => {
    onClose();
    void fn();
  };
  const name = chat.title || "Untitled";

  if (mode === "rename") {
    const save = () => run(() => renameWorkspace(chat.id, title.trim() || chat.title));
    return (
      <Sheet
        open
        onClose={onClose}
        title="Rename Chat"
        action={
          <PhoneButton kind="plain" disabled={!title.trim()} onClick={save}>
            Save
          </PhoneButton>
        }
      >
        <form
          class="px-4 pt-1 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) save();
          }}
        >
          <PhoneInput aria-label="Chat title" value={title} autoFocus onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
        </form>
      </Sheet>
    );
  }
  if (mode === "move") {
    return (
      <MoveToFolderSheet
        name={name}
        projectId={chat.projectId}
        envId={envIdOf(chat)}
        current={folderOfWorkspace(chat)}
        onMove={(folderId) => void moveWorkspaceToFolder(chat.id, folderId)}
        onClose={onClose}
      />
    );
  }
  if (mode === "delete") {
    return (
      <Sheet open onClose={onClose} title="Delete Chat?">
        <div class="flex flex-col gap-3 px-4 pt-1 pb-2">
          <p class="text-center text-[15px] text-fg-muted">
            “{name}” will be permanently deleted{chat.worktree ? " (its worktree branch is kept)" : ""}. This can't be undone.
          </p>
          <PhoneButton kind="tinted" class="bg-danger/12 text-danger active:bg-danger/20" onClick={() => run(() => deleteWorkspace(chat.id))}>
            Delete
          </PhoneButton>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet open onClose={onClose} title={name}>
      <div class="pt-1">
        <ListGroup>
          <ListRow title="Rename" onClick={() => setMode("rename")} />
          <ListRow title={chat.pinned ? "Unpin" : "Pin"} onClick={() => run(() => setWorkspacePinned(chat.id, !chat.pinned))} />
          <ListRow title="Move to Folder…" onClick={() => setMode("move")} />
          {chat.unread ? (
            <ListRow title="Mark as Read" onClick={() => run(() => markWorkspaceRead(chat.id))} />
          ) : (
            <ListRow title="Mark as Unread" onClick={() => run(() => markWorkspaceUnread(chat.id))} />
          )}
        </ListGroup>
        <ListGroup>
          <ListRow title="Delete…" tone="danger" onClick={() => setMode("delete")} />
        </ListGroup>
      </div>
    </Sheet>
  );
}
