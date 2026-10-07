/**
 * Folders in the chat list (I-165, reworked in I-202): user-made groups of chats, stored per
 * environment on its server like projects and pins, synced to every client.
 *
 * One level deep (no folders in folders), and folders only ever hold chats:
 * - **Project** folders (`projectId` set) hold some of that project's chats.
 * - **Chats-section** folders (`projectId: null`) hold standalone chats and are listed in the
 *   Chats section. (Before I-202 these were "top-level" folders in the project list that could
 *   also hold projects; projects are always top level now.)
 *
 * Order (I-202, `chat-order.ts`): a list's top level (a project's, or the Chats section) is one
 * manual order of its chats and folders mixed (`Workspace.sortOrder`, `Folder.sortOrder`, one
 * number space), below its pinned chats; a folder orders its chats the same way. New chats and
 * folders go to the top. `PUT /api/workspaces/order` rewrites one container's order.
 *
 * Membership lives on the member (`Workspace.folderId`). Deleting a folder puts its chats in its
 * place; nothing else is deleted. Deleting a project deletes its folders.
 *
 *   GET    /api/folders                 → Folder[]
 *   POST   /api/folders                 CreateFolderRequest → Folder (top of its list)
 *   PATCH  /api/folders/:id             UpdateFolderRequest → Folder
 *   DELETE /api/folders/:id             → 204 (its chats take its place)
 *   PATCH  /api/workspaces/:id          { folderId } moves a chat in (to the top) / out (after it)
 *   PUT    /api/workspaces/order        ReorderChatListRequest → ReorderChatListResponse
 */

export interface Folder {
  /** ULID. */
  id: string;
  name: string;
  /** `null`: a Chats-section folder (standalone chats); else the project it belongs to. */
  projectId: string | null;
  /** Manual position (ascending) at its list's top level, among its chats and folders (I-202). */
  sortOrder: number;
  createdAt: number;
  /** The environment (server) it's stored on; clients tag it like projects (I-123). */
  environmentId?: string;
}

/** `POST /api/folders`. */
export interface CreateFolderRequest {
  name: string;
  /** The project to create it in (omit / `null`: a Chats-section folder). */
  projectId?: string | null;
}

/** `PATCH /api/folders/:id`. */
export interface UpdateFolderRequest {
  name?: string;
}

/** Folders in their manual order (`sortOrder`, then oldest first). */
export function compareFolders(a: Folder, b: Folder): number {
  return a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/**
 * Whether `folder` can hold a chat of `projectId` (`null` = standalone): Chats-section folders take
 * standalone chats, project folders take their own project's chats.
 */
export function folderAcceptsChat(folder: Pick<Folder, "projectId">, projectId: string | null): boolean {
  return folder.projectId === projectId;
}

/** Longest folder name accepted. */
export const MAX_FOLDER_NAME = 120;
