/**
 * Context bar: the folder a new chat in a **group project** works in (I-213). Required: until one
 * is chosen the chip reads "Choose folder…" and the composer won't send. It opens the shared
 * folder browser (the group's environment's folders, reopening where it was last left) in a
 * dialog; the group's other chats' folders are its Recent shortcuts. The choice lives in
 * `state/new-chat-folder.ts` and is cleared when the new-chat screen goes away.
 */
import { useState } from "preact/hooks";
import { ChevronDown, Folder, FolderSearch } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";
import { shortenPath } from "@glade/app-core/lib/paths";
import { envFolderSource } from "@glade/app-core/state/folder-source";
import { newChatFolderFor, setNewChatFolder } from "@glade/app-core/state/new-chat-folder";
import { envIdOfProject, projectsById, workspaces } from "@glade/app-core/state/store";
import { Dialog, FolderBrowser } from "@glade/app-core/ui";
import { baseName } from "@glade/app-core/ui/FolderBrowser";
import { barButtonClass } from "./shared";

/** The folders the group's chats work in, most recently active first (Recent shortcuts). */
export function groupChatFolders(projectId: string): string[] {
  const chats = workspaces.value.filter((w) => w.projectId === projectId).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return [...new Set(chats.map((w) => w.cwd))];
}

export function FolderPicker({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const folder = newChatFolderFor(projectId);
  const env = envIdOfProject(projectId);
  const source = envFolderSource(env);
  const group = projectsById.value.get(projectId);

  return (
    <>
      <button
        type="button"
        class={cn(barButtonClass, !folder && "text-accent hover:text-accent")}
        aria-label={folder ? `Folder: ${baseName(folder)}` : "Folder: none, choose one"}
        title={folder ? shortenPath(folder) : "Choose the folder this chat works in"}
        data-state={open ? "open" : undefined}
        onClick={() => setOpen(true)}
      >
        {folder ? <Folder /> : <FolderSearch />}
        <span class="truncate">{folder ? baseName(folder) : "Choose folder…"}</span>
        <ChevronDown size={10} strokeWidth={2.5} class="opacity-60" />
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Choose a folder"
        description={`The chat${group ? ` in ${group.name}` : ""} works in this folder. It can't be changed later.`}
        width={620}
      >
        <FolderBrowser
          browse={source.browse}
          mkdir={source.mkdir}
          // The current choice, else where the browser was last left on this device.
          initialPath={folder ?? undefined}
          memoryKey={env}
          recent={groupChatFolders(projectId)}
          onChoose={(path) => {
            setNewChatFolder(projectId, path);
            setOpen(false);
          }}
          onCancel={() => setOpen(false)}
        />
      </Dialog>
    </>
  );
}
