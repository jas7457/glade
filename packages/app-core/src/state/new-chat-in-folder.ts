/**
 * The sidebar folder a new chat should start in (I-215): set by the new-chat screen when its
 * route carries `?folder=<id>` (a folder's "+" / "New Chat"), cleared when the screen goes away.
 * `createWorkspace` asks `folderIdRequestFor` what to send as `CreateWorkspaceRequest.folderId`;
 * the choice only applies to the list it was made for (the folder's project, or the Chats
 * section), so switching project on the new-chat screen never sends a stale folder.
 */
import { signal } from "@preact/signals";
import type { CreateWorkspaceRequest, Folder } from "@glade/protocol";
import { foldersById } from "@glade/app-core/state/store";

/** The folder chosen for the next new chat, or null. */
export const newChatInFolder = signal<string | null>(null);

/** Set (or clear, with null) the folder the new chat starts in. */
export function setNewChatInFolder(folderId: string | null): void {
  newChatInFolder.value = folderId;
}

/** The folder a new chat of `projectId` (null = standalone) would start in, or null. */
export function newChatTargetFolder(projectId: string | null): Folder | null {
  const id = newChatInFolder.value;
  const folder = id ? foldersById.value.get(id) : undefined;
  return folder && folder.projectId === projectId ? folder : null;
}

/** The `folderId` field of a new chat's `CreateWorkspaceRequest` for the current choice. */
export function folderIdRequestFor(projectId: string | null): Pick<CreateWorkspaceRequest, "folderId"> {
  const folder = newChatTargetFolder(projectId);
  return folder ? { folderId: folder.id } : {};
}
