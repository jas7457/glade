/**
 * Folder actions (I-165): create, rename, delete, reorder, and moving projects and chats in and
 * out. Like `actions.ts`: requests go to the environment the item belongs to, results are applied
 * to the signals right away (the server's pushes are idempotent), failures become toasts.
 */
import type { Folder } from "@glade/protocol";
import { apiFor, apiForProject, apiForWorkspace } from "./env-api";
import { connectionFor } from "./env-registry";
import { entryId, type TreeDrop } from "./folders";
import { reorderProjects, stepOrder } from "./actions";
import { envIdOf, folders, foldersById, foldersForProject, projects, sidebarEntries, upsert, workspaces } from "./store";
import { notify } from "./toasts";

function fail(prefix: string, err: unknown): void {
  notify("error", `${prefix}: ${(err as Error).message}`);
}

/** Tag an item from an environment's server (untagged = local, like `actions.ts`). */
function tagged<T extends { environmentId?: string }>(item: T, envId: string | undefined): T {
  return envId && connectionFor(envId) && item.environmentId !== envId ? { ...item, environmentId: envId } : item;
}

/**
 * A new folder: top-level on `envId` (projectId null), or in a project (its environment).
 * Null (and a toast) on failure.
 */
export async function createFolder(name: string, where: { projectId: string } | { envId?: string }): Promise<Folder | null> {
  const projectId = "projectId" in where ? where.projectId : null;
  const env = projectId ? envIdOf(projects.value.find((p) => p.id === projectId)) : "envId" in where ? where.envId : undefined;
  try {
    const folder = tagged(await apiFor(env).createFolder({ name, projectId }), env);
    folders.value = upsert(folders.value, folder);
    return folder;
  } catch (err) {
    fail("Could not create folder", err);
    return null;
  }
}

const apiForFolder = (id: string) => apiFor(envIdOf(foldersById.value.get(id)));

export async function renameFolder(id: string, name: string): Promise<boolean> {
  const before = foldersById.value.get(id);
  if (!before || !name.trim()) return false;
  folders.value = upsert(folders.value, { ...before, name: name.trim() });
  try {
    const folder = await apiForFolder(id).updateFolder(id, { name });
    folders.value = upsert(folders.value, tagged(folder, before.environmentId));
    return true;
  } catch (err) {
    folders.value = upsert(folders.value, before);
    fail("Could not rename folder", err);
    return false;
  }
}

/** Delete a folder; its projects and chats move back out (the server pushes them). */
export async function deleteFolder(id: string): Promise<boolean> {
  const before = foldersById.value.get(id);
  if (!before) return false;
  try {
    await apiForFolder(id).deleteFolder(id);
    folders.value = folders.value.filter((f) => f.id !== id);
    return true;
  } catch (err) {
    fail("Could not delete folder", err);
    return false;
  }
}

/** Move a project into a top-level folder of its environment (`null`: out of its folder). */
export async function moveProjectToFolder(projectId: string, folderId: string | null): Promise<boolean> {
  const before = projects.value.find((p) => p.id === projectId);
  if (!before || (before.folderId ?? null) === folderId) return false;
  projects.value = upsert(projects.value, { ...before, folderId });
  try {
    const project = await apiForProject(projectId).updateProject(projectId, { folderId });
    projects.value = upsert(projects.value, tagged(project, before.environmentId));
    return true;
  } catch (err) {
    projects.value = upsert(projects.value, before);
    fail("Could not move project", err);
    return false;
  }
}

/** Move a chat into a folder (top-level for standalone chats, its project's otherwise); `null`: out. */
export async function moveWorkspaceToFolder(workspaceId: string, folderId: string | null): Promise<boolean> {
  const before = workspaces.value.find((w) => w.id === workspaceId);
  if (!before || (before.folderId ?? null) === folderId) return false;
  workspaces.value = upsert(workspaces.value, { ...before, folderId });
  try {
    const workspace = await apiForWorkspace(workspaceId).updateWorkspace(workspaceId, { folderId });
    workspaces.value = upsert(workspaces.value, tagged(workspace, before.environmentId));
    return true;
  } catch (err) {
    workspaces.value = upsert(workspaces.value, before);
    fail("Could not move chat", err);
    return false;
  }
}

/** Reorder a project's folders (every folder of it, in the new order). */
export async function reorderProjectFolders(projectId: string, ids: string[]): Promise<boolean> {
  const before = new Map(folders.value.map((f) => [f.id, f.sortOrder]));
  const order = new Map(ids.map((id, i) => [id, i]));
  folders.value = folders.value.map((f) => (order.has(f.id) ? { ...f, sortOrder: order.get(f.id)! } : f));
  try {
    await apiForProject(projectId).reorderFolders(projectId, ids);
    return true;
  } catch (err) {
    folders.value = folders.value.map((f) => (before.has(f.id) ? { ...f, sortOrder: before.get(f.id)! } : f));
    fail("Could not reorder folders", err);
    return false;
  }
}

/** Keyboard alternative to dragging a project's folder: one step up or down. */
export function moveProjectFolder(id: string, delta: -1 | 1): Promise<boolean> {
  const folder = foldersById.value.get(id);
  if (!folder?.projectId) return Promise.resolve(false);
  const next = stepOrder(
    foldersForProject(folder.projectId).map((f) => f.id),
    id,
    delta,
  );
  return next ? reorderProjectFolders(folder.projectId, next) : Promise.resolve(false);
}

/**
 * Apply a drop in the project list (`resolveTreeDrop`): move the dragged project in or out of a
 * folder first (the server places it), then send the exact order.
 */
export async function applyProjectDrop(drop: TreeDrop): Promise<boolean> {
  if (drop.moved && !(await moveProjectToFolder(drop.moved.id, drop.moved.folderId))) return false;
  // Top-level entries that weren't rendered (none today) keep their place at the end.
  const top = [...drop.top, ...sidebarEntries.value.map(entryId).filter((id) => !drop.top.includes(id))];
  return reorderProjects(top, drop.inside);
}
