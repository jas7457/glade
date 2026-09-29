/**
 * Folders in the chat list (I-165): user-made groups, stored per environment on its server like
 * projects and pins, synced to every client.
 *
 * Two kinds, one level deep (no folders in folders):
 * - **Top-level** folders (`projectId: null`) hold projects and standalone chats. They sit in the
 *   sidebar's project list and share its manual order with the projects (`sortOrder`, one number
 *   space: `PUT /projects/order` may list folder ids between project ids).
 * - **Project** folders (`projectId` set) hold some of that project's chats. They're listed at the
 *   top of the project, in their own manual order (`PUT /folders/order`).
 *
 * Membership lives on the member: `Project.folderId` (a top-level folder) and `Workspace.folderId`
 * (a top-level folder for standalone chats, a folder of the chat's own project otherwise).
 * Deleting a folder moves its contents back out; nothing else is deleted. Deleting a project
 * deletes its folders.
 *
 *   GET    /api/folders                 → Folder[]
 *   POST   /api/folders                 CreateFolderRequest → Folder (top of its list)
 *   PATCH  /api/folders/:id             UpdateFolderRequest → Folder
 *   PUT    /api/folders/order           ReorderFoldersRequest → Folder[] (that project's folders)
 *   DELETE /api/folders/:id             → 204 (members move out)
 *   PATCH  /api/projects/:id            { folderId } moves a project in/out
 *   PATCH  /api/workspaces/:id          { folderId } moves a chat in/out
 */

export interface Folder {
  /** ULID. */
  id: string;
  name: string;
  /** `null`: a top-level folder (projects and standalone chats); else the project it belongs to. */
  projectId: string | null;
  /** Manual position (ascending): among projects and top-level folders, or among the project's folders. */
  sortOrder: number;
  createdAt: number;
  /** The environment (server) it's stored on; clients tag it like projects (I-123). */
  environmentId?: string;
}

/** `POST /api/folders`. */
export interface CreateFolderRequest {
  name: string;
  /** The project to create it in (omit / `null`: a top-level folder). */
  projectId?: string | null;
}

/** `PATCH /api/folders/:id`. */
export interface UpdateFolderRequest {
  name?: string;
}

/** `PUT /api/folders/order`: every folder of one project, in the new order. */
export interface ReorderFoldersRequest {
  projectId: string;
  ids: string[];
}

/** Folders in their manual order (`sortOrder`, then oldest first). */
export function compareFolders(a: Folder, b: Folder): number {
  return a.sortOrder - b.sortOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/**
 * Whether `folder` can hold a chat of `projectId` (`null` = standalone): top-level folders take
 * standalone chats, project folders take their own project's chats.
 */
export function folderAcceptsChat(folder: Pick<Folder, "projectId">, projectId: string | null): boolean {
  return folder.projectId === projectId;
}

/** Longest folder name accepted. */
export const MAX_FOLDER_NAME = 120;
