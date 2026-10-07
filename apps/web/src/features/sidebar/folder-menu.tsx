/**
 * "Move to Folder" (I-165): the submenu of a chat row listing the folders it can go in (its
 * environment's Chats-section folders for standalone chats, its project's folders for a
 * project's chats), "New Folder" (created as "New Folder", the chat moved in, the name ready to
 * edit, like Finder) and "Remove from Folder". Projects never go in folders (I-202).
 */
import { signal } from "@preact/signals";
import { FolderInput, FolderMinus, FolderPlus, Folders } from "lucide-preact";
import type { Folder } from "@glade/protocol";
import { MenuCheckItem, MenuItem, MenuSeparator, MenuSub } from "@glade/app-core/ui";
import { createFolder } from "@glade/app-core/state/folder-actions";
import { envIdOf, foldersForProject } from "@glade/app-core/state/store";

/** The folder whose name is being edited in place (a new folder, or "Rename"). */
export const renamingFolderId = signal<string | null>(null);

export const NEW_FOLDER_NAME = "New Folder";

/** Create a folder and put its name in edit mode. */
export async function createFolderAndRename(where: { projectId: string } | { envId: string }): Promise<Folder | null> {
  const folder = await createFolder(NEW_FOLDER_NAME, where);
  if (folder) renamingFolderId.value = folder.id;
  return folder;
}

/** The Chats-section folders of an environment in their order. */
export function chatsFoldersOf(envId: string): Folder[] {
  return foldersForProject(null).filter((f) => envIdOf(f) === envId);
}

export interface MoveToFolderMenuProps {
  /** Project id for a project's chats; null for standalone chats. */
  projectId: string | null;
  envId: string;
  /** The folder the item is in now. */
  current: string | null;
  onMove: (folderId: string | null) => void;
}

export function MoveToFolderMenu({ projectId, envId, current, onMove }: MoveToFolderMenuProps) {
  const options = projectId ? foldersForProject(projectId) : chatsFoldersOf(envId);
  const newFolder = async () => {
    const folder = await createFolderAndRename(projectId ? { projectId } : { envId });
    if (folder) onMove(folder.id);
  };
  return (
    <MenuSub icon={<FolderInput />} label="Move to Folder">
      {options.map((f) => (
        <MenuCheckItem key={f.id} icon={<Folders />} checked={f.id === current} onSelect={() => f.id !== current && onMove(f.id)}>
          {f.name}
        </MenuCheckItem>
      ))}
      {options.length > 0 && <MenuSeparator />}
      <MenuItem icon={<FolderPlus />} onSelect={() => void newFolder()}>New Folder</MenuItem>
      {current && <MenuItem icon={<FolderMinus />} onSelect={() => onMove(null)}>Remove from Folder</MenuItem>}
    </MenuSub>
  );
}
