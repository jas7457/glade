/**
 * Folder actions (I-165, I-202): create, rename, delete, moving chats in and out, and the manual
 * order of a chat list's containers (`reorderChatList`). Like `actions.ts`: requests go to the environment the item belongs to, results are applied
 * to the signals right away (the server's pushes are idempotent), failures become toasts.
 */
import type { Folder, WorkspaceSummary } from "@glade/protocol";
import { apiFor, apiForWorkspace } from "./env-api";
import { connectionFor } from "./env-registry";
import { setClientOrder } from "./env-order";
import { chatListOf, chatOrderList, envIdOf, folders, foldersById, itemOrderKey, projects, upsert, workspaces } from "./store";
import { notify } from "./toasts";

function fail(prefix: string, err: unknown): void {
  notify("error", `${prefix}: ${(err as Error).message}`);
}

/** Tag an item from an environment's server (untagged = local, like `actions.ts`). */
function tagged<T extends { environmentId?: string }>(item: T, envId: string | undefined): T {
  return envId && connectionFor(envId) && item.environmentId !== envId ? { ...item, environmentId: envId } : item;
}

/**
 * A new folder: in the Chats section of `envId` (projectId null), or in a project (its environment).
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

/** Delete a folder; its chats take its place (the server pushes them). */
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

/**
 * Move a chat into a folder (a Chats-section one for standalone chats, its project's otherwise; it
 * goes to the folder's top); `null`: out (right after the folder). The server places it.
 */
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

/**
 * Rewrite one container of a chat list (I-202): the top level of a project (`folderId` null) or of
 * the Chats section (`projectId` null), or one folder. `ids` is the container's new visual order
 * (chats and, at the top level, folders; it may list chats moving in from another container of
 * the same list, which move here). Applied optimistically: `sortOrder` = index within its
 * environment, moved chats get `folderId`. A top level mixing environments (standalone chats)
 * keeps the interleave on this device and sends each environment its own part. Members the list
 * doesn't name (e.g. arrived meanwhile) keep their place after the rest. Restored and reported
 * if a server rejects it.
 */
export async function reorderChatList(projectId: string | null, folderId: string | null, ids: string[]): Promise<boolean> {
  const allWorkspaces = workspaces.value;
  const allFolders = folders.value;
  const chatById = new Map(allWorkspaces.map((w) => [w.id, w]));
  const folderById = new Map(allFolders.map((f) => [f.id, f]));
  const itemOf = (id: string) => chatById.get(id) ?? folderById.get(id);
  const listed = ids.filter((id) => {
    const chat = chatById.get(id);
    if (chat) return chat.projectId === projectId;
    const folder = folderById.get(id);
    return !!folder && folder.projectId === projectId && folderId === null;
  });
  if (!listed.length) return false;
  const beforeChats = new Map(allWorkspaces.map((w) => [w.id, w]));
  const beforeFolders = new Map(allFolders.map((f) => [f.id, f]));
  if (folderId === null) setClientOrder(chatOrderList(projectId), listed.map((id) => itemOrderKey(itemOf(id)!)));
  // Members the request must name (the server checks the set): what's in the container now.
  const view = chatListOf(projectId);
  const members =
    folderId === null
      ? view.entries.map((e) => (e.kind === "chat" ? e.chat.id : e.folder.id))
      : (view.entries.find((e) => e.kind === "folder" && e.folder.id === folderId) as { chats: WorkspaceSummary[] } | undefined)?.chats.filter((c) => !c.pinned).map((c) => c.id) ?? [];
  const envs = [...new Set(listed.map((id) => envIdOf(itemOf(id))))];
  const parts = envs.map((env) => {
    const mine = listed.filter((id) => envIdOf(itemOf(id)) === env);
    return [...mine, ...members.filter((id) => !mine.includes(id) && envIdOf(itemOf(id)) === env)];
  });
  const order = new Map(parts.flatMap((part) => part.map((id, i) => [id, i] as const)));
  workspaces.value = allWorkspaces.map((w) => (order.has(w.id) ? { ...w, sortOrder: order.get(w.id), folderId } : w));
  folders.value = allFolders.map((f) => (order.has(f.id) ? { ...f, sortOrder: order.get(f.id)! } : f));
  try {
    for (const [i, env] of envs.entries()) {
      const mine = parts[i]!;
      // In a mixed-environment list, only environments whose own order changed are asked.
      if (envs.length > 1 && !mine.some((id) => isChanged(id, order.get(id)!, folderId, beforeChats, beforeFolders))) continue;
      const res = await apiFor(env).reorderChatList({ projectId, folderId, ids: mine });
      workspaces.value = res.workspaces.reduce((list, w) => upsert(list, tagged(w, env)), workspaces.value);
      folders.value = res.folders.reduce((list, f) => upsert(list, tagged(f, env)), folders.value);
    }
    return true;
  } catch (err) {
    workspaces.value = workspaces.value.map((w) => beforeChats.get(w.id) ?? w);
    folders.value = folders.value.map((f) => beforeFolders.get(f.id) ?? f);
    fail("Could not move chat", err);
    return false;
  }
}

function isChanged(id: string, sortOrder: number, folderId: string | null, chats: ReadonlyMap<string, WorkspaceSummary>, folderMap: ReadonlyMap<string, Folder>): boolean {
  const chat = chats.get(id);
  if (chat) return chat.sortOrder !== sortOrder || (chat.folderId ?? null) !== folderId;
  return folderMap.get(id)?.sortOrder !== sortOrder;
}
