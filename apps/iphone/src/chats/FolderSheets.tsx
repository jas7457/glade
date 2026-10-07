/**
 * Folder sheets on the iPhone (I-165; iOS has no context menus over web content, so long-press
 * opens a bottom sheet): "Move to Folder" for a chat (the folders it can go in, New Folder…,
 * Remove from Folder), a folder's actions (Rename, Delete) and a project's (New Folder). Projects
 * never go in folders (I-202).
 */
import { useEffect, useState } from "preact/hooks";
import type { Folder, Project } from "@glade/protocol";
import { Check, FolderMinus, FolderPlus, Folders, Pencil, Trash2 } from "lucide-preact";
import { createFolder, deleteFolder, renameFolder } from "@glade/app-core/state/folder-actions";
import { envIdOf, foldersForProject } from "@glade/app-core/state/store";
import { ListGroup, ListRow, PhoneButton, PhoneInput, Sheet } from "~/ui/phone";

/** The Chats-section folders of an environment in their order. */
function chatsFolders(envId: string): Folder[] {
  return foldersForProject(null).filter((f) => envIdOf(f) === envId);
}

/** A one-field form sheet (folder name). */
function NameSheet({ title, initial, actionLabel, onSave, onClose }: { title: string; initial: string; actionLabel: string; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const save = () => name.trim() && onSave(name.trim());
  return (
    <Sheet
      open
      onClose={onClose}
      title={title}
      action={
        <PhoneButton kind="plain" disabled={!name.trim()} onClick={save}>
          {actionLabel}
        </PhoneButton>
      }
    >
      <form
        class="px-4 pt-1 pb-3"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <PhoneInput aria-label="Folder name" value={name} autoFocus onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
      </form>
    </Sheet>
  );
}

export interface MoveToFolderSheetProps {
  /** What's moved (the sheet's title). */
  name: string;
  /** A project's chats: its folders. Null: standalone chats (the Chats section's folders). */
  projectId: string | null;
  envId: string;
  current: string | null;
  onMove: (folderId: string | null) => void;
  onClose: () => void;
}

export function MoveToFolderSheet({ name, projectId, envId, current, onMove, onClose }: MoveToFolderSheetProps) {
  const [creating, setCreating] = useState(false);
  const options = projectId ? foldersForProject(projectId) : chatsFolders(envId);
  const move = (folderId: string | null) => {
    onClose();
    onMove(folderId);
  };
  if (creating) {
    return (
      <NameSheet
        title="New Folder"
        initial=""
        actionLabel="Create"
        onClose={onClose}
        onSave={async (folderName) => {
          onClose();
          const folder = await createFolder(folderName, projectId ? { projectId } : { envId });
          if (folder) onMove(folder.id);
        }}
      />
    );
  }
  return (
    <Sheet open onClose={onClose} title={`Move “${name}”`}>
      <div class="pt-1">
        {options.length > 0 && (
          <ListGroup header="Folders">
            {options.map((f) => (
              <ListRow key={f.id} icon={<Folders size={20} />} title={f.name} detail={f.id === current ? <Check size={18} class="text-accent" aria-label="Current folder" /> : undefined} onClick={() => (f.id === current ? onClose() : move(f.id))} />
            ))}
          </ListGroup>
        )}
        <ListGroup>
          <ListRow icon={<FolderPlus size={20} />} title="New Folder…" tone="accent" onClick={() => setCreating(true)} />
          {current && <ListRow icon={<FolderMinus size={20} />} title="Remove from Folder" onClick={() => move(null)} />}
        </ListGroup>
      </div>
    </Sheet>
  );
}

type FolderMode = "menu" | "rename" | "delete";

/** A folder's actions: Rename, Delete (its chats take its place). */
export function FolderActionsSheet({ folder, onClose }: { folder: Folder | null; onClose: () => void }) {
  const [mode, setMode] = useState<FolderMode>("menu");
  useEffect(() => setMode("menu"), [folder?.id]);
  if (!folder) return null;
  const run = (fn: () => unknown) => {
    onClose();
    void fn();
  };
  if (mode === "rename") {
    return <NameSheet title="Rename Folder" initial={folder.name} actionLabel="Save" onClose={onClose} onSave={(name) => run(() => renameFolder(folder.id, name))} />;
  }
  if (mode === "delete") {
    return (
      <Sheet open onClose={onClose} title="Delete Folder?">
        <div class="flex flex-col gap-3 px-4 pt-1 pb-2">
          <p class="text-center text-[15px] text-fg-muted">
            “{folder.name}” will be deleted. Its chats move back out; nothing else is deleted.
          </p>
          <PhoneButton kind="tinted" class="bg-danger/12 text-danger active:bg-danger/20" onClick={() => run(() => deleteFolder(folder.id))}>
            Delete Folder
          </PhoneButton>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet open onClose={onClose} title={folder.name}>
      <div class="pt-1">
        <ListGroup>
          <ListRow icon={<Pencil size={20} />} title="Rename" onClick={() => setMode("rename")} />
        </ListGroup>
        <ListGroup>
          <ListRow icon={<Trash2 size={20} />} title="Delete Folder…" tone="danger" onClick={() => setMode("delete")} />
        </ListGroup>
      </div>
    </Sheet>
  );
}

type ProjectMode = "menu" | "newFolder";

/** A project's folder actions: New Folder (in it). */
export function ProjectActionsSheet({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const [mode, setMode] = useState<ProjectMode>("menu");
  useEffect(() => setMode("menu"), [project?.id]);
  if (!project) return null;
  if (mode === "newFolder") {
    return (
      <NameSheet
        title="New Folder"
        initial=""
        actionLabel="Create"
        onClose={onClose}
        onSave={(name) => {
          onClose();
          void createFolder(name, { projectId: project.id });
        }}
      />
    );
  }
  return (
    <Sheet open onClose={onClose} title={project.name}>
      <div class="pt-1">
        <ListGroup>
          <ListRow icon={<FolderPlus size={20} />} title="New Folder…" onClick={() => setMode("newFolder")} />
        </ListGroup>
      </div>
    </Sheet>
  );
}
