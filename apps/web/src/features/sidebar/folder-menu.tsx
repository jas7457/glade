/**
 * "Move to Folder" (I-165): the submenu of a chat or project row listing the folders it can go in
 * (its environment's top-level folders for projects and standalone chats, its project's folders
 * for a project's chats), "New Folder" (created as "New Folder", the item moved in, the name
 * ready to edit, like Finder) and "Remove from Folder".
 */
import { signal } from "@preact/signals";
import type { Folder } from "@glade/protocol";
import { MenuCheckItem, MenuItem, MenuSeparator, MenuSub } from "@/ui";
import { createFolder } from "@/state/folder-actions";
import { envIdOf, folders, foldersForProject } from "@/state/store";

/** The folder whose name is being edited in place (a new folder, or "Rename"). */
export const renamingFolderId = signal<string | null>(null);

export const NEW_FOLDER_NAME = "New Folder";

/** Create a folder and put its name in edit mode. */
export async function createFolderAndRename(where: { projectId: string } | { envId: string }): Promise<Folder | null> {
  const folder = await createFolder(NEW_FOLDER_NAME, where);
  if (folder) renamingFolderId.value = folder.id;
  return folder;
}

/** Top-level folders of an environment in their order. */
export function topLevelFoldersOf(envId: string): Folder[] {
  return folders.value.filter((f) => f.projectId === null && envIdOf(f) === envId).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt);
}

export interface MoveToFolderMenuProps {
  /** Project id for a project's chats; null for projects and standalone chats. */
  projectId: string | null;
  envId: string;
  /** The folder the item is in now. */
  current: string | null;
  onMove: (folderId: string | null) => void;
}

export function MoveToFolderMenu({ projectId, envId, current, onMove }: MoveToFolderMenuProps) {
  const options = projectId ? foldersForProject(projectId) : topLevelFoldersOf(envId);
  const newFolder = async () => {
    const folder = await createFolderAndRename(projectId ? { projectId } : { envId });
    if (folder) onMove(folder.id);
  };
  return (
    <MenuSub label="Move to Folder">
      {options.map((f) => (
        <MenuCheckItem key={f.id} checked={f.id === current} onSelect={() => f.id !== current && onMove(f.id)}>
          {f.name}
        </MenuCheckItem>
      ))}
      {options.length > 0 && <MenuSeparator />}
      <MenuItem onSelect={() => void newFolder()}>New Folder</MenuItem>
      {current && <MenuItem onSelect={() => onMove(null)}>Remove from Folder</MenuItem>}
    </MenuSub>
  );
}
