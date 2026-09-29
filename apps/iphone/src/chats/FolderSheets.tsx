/**
 * Folder sheets on the iPhone (I-165; iOS has no context menus over web content, so long-press
 * opens a bottom sheet): "Move to Folder" for a chat or a project (the folders it can go in, New
 * Folder…, Remove from Folder), a folder's actions (Rename, Delete) and a project's (New Folder,
 * Move to Folder).
 */
import { useEffect, useState } from "preact/hooks";
import type { Folder, Project } from "@glade/protocol";
import { Check, FolderInput, FolderMinus, FolderPlus, Folders, Pencil, Trash2 } from "lucide-preact";
import { createFolder, deleteFolder, moveProjectToFolder, renameFolder } from "@glade/app-core/state/folder-actions";
import { envIdOf, folders, foldersForProject, sidebarEntries } from "@glade/app-core/state/store";
import { ListGroup, ListRow, PhoneButton, PhoneInput, Sheet } from "~/ui/phone";

/** Top-level folders of an environment in their order. */
function topLevelFolders(envId: string): Folder[] {
  return folders.value.filter((f) => f.projectId === null && envIdOf(f) === envId).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
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
  /** A project's chats: its folders. Null: projects and standalone chats (top-level folders). */
  projectId: string | null;
  envId: string;
  current: string | null;
  onMove: (folderId: string | null) => void;
  onClose: () => void;
}

export function MoveToFolderSheet({ name, projectId, envId, current, onMove, onClose }: MoveToFolderSheetProps) {
  const [creating, setCreating] = useState(false);
  const options = projectId ? foldersForProject(projectId) : topLevelFolders(envId);
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

/** A folder's actions: Rename, Delete (its contents move back out). */
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
            “{folder.name}” will be deleted. {folder.projectId ? "Its chats move" : "Its projects and chats move"} back out; nothing else is deleted.
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

type ProjectMode = "menu" | "newFolder" | "move";

/** The top-level folder a project is shown in, or null. */
function folderOfProject(project: Project): string | null {
  for (const e of sidebarEntries.value) if (e.kind === "folder" && e.projects.some((p) => p.id === project.id)) return e.folder.id;
  return null;
}

/** A project's folder actions: New Folder (in it), Move to Folder. */
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
  if (mode === "move") {
    return (
      <MoveToFolderSheet
        name={project.name}
        projectId={null}
        envId={envIdOf(project)}
        current={folderOfProject(project)}
        onMove={(folderId) => void moveProjectToFolder(project.id, folderId)}
        onClose={onClose}
      />
    );
  }
  return (
    <Sheet open onClose={onClose} title={project.name}>
      <div class="pt-1">
        <ListGroup>
          <ListRow icon={<FolderPlus size={20} />} title="New Folder…" onClick={() => setMode("newFolder")} />
          <ListRow icon={<FolderInput size={20} />} title="Move to Folder…" onClick={() => setMode("move")} />
        </ListGroup>
      </div>
    </Sheet>
  );
}
