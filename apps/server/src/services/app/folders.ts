/**
 * Folders and the manual order of chat lists (I-165, I-202; types and rules in `@glade/protocol`
 * folders.ts and chat-order.ts): create, rename, delete folders (their chats take their place),
 * move chats in and out, and rewrite one container's order (`PUT /workspaces/order`).
 *
 * A list is a project's chats or the standalone Chats section (`projectId` null). Its containers
 * are its top level (chats not in a folder, and the list's folders, in one `sortOrder` space) and
 * each folder (its chats). A chat's folder only counts when that folder exists in its list; any
 * other `folderId` is treated as "not in a folder", so a stale id never hides a chat. Changes
 * that need room renumber the container 0..n−1; only records whose number (or folder) changed
 * are written and pushed.
 */
import {
  compareFolders,
  compareListOrder,
  MAX_FOLDER_NAME,
  topSortOrder,
  type CreateFolderRequest,
  type Folder,
  type ReorderChatListRequest,
  type ReorderChatListResponse,
  type UpdateFolderRequest,
  type Workspace,
} from "@glade/protocol";
import { ulid } from "../../store/db/ids.js";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";
import type { Records } from "./records.js";

type Item = { kind: "chat"; item: Workspace } | { kind: "folder"; item: Folder };

/** Pinned chats first (by `pinOrder`), then the container's manual order. */
const byPlace = (a: Item, b: Item) => {
  const ap = a.kind === "chat" && a.item.pinned;
  const bp = b.kind === "chat" && b.item.pinned;
  if (ap !== bp) return ap ? -1 : 1;
  if (ap && bp) return ((a.item as Workspace).pinOrder ?? 0) - ((b.item as Workspace).pinOrder ?? 0) || compareListOrder(a.item, b.item);
  return compareListOrder(a.item, b.item);
};

export class Folders {
  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
  ) {}

  private get store() {
    return this.ctx.store;
  }

  /** Every folder: the Chats section's first, then by project; each list in its manual order. */
  listFolders(): Folder[] {
    return this.store.listFolders().sort((a, b) => (a.projectId === null ? 0 : 1) - (b.projectId === null ? 0 : 1) || compareFolders(a, b));
  }

  requireFolder(id: string): Folder {
    const folder = this.store.getFolder(id);
    if (!folder) throw new HttpError(404, "Folder not found");
    return folder;
  }

  createFolder(req: CreateFolderRequest): Folder {
    const name = folderName(req.name);
    const projectId = req.projectId ?? null;
    if (projectId !== null) this.records.requireProject(projectId);
    const folder: Folder = {
      id: ulid(),
      name,
      projectId,
      // New folders go to the top of their list (I-202: above its chats too).
      sortOrder: topSortOrder(this.members(projectId, null).map((e) => e.item)),
      createdAt: Date.now(),
      environmentId: this.store.environmentId,
    };
    this.store.upsertFolder(folder);
    this.ctx.broadcast({ type: "folder_upsert", folder });
    return folder;
  }

  updateFolder(id: string, req: UpdateFolderRequest): Folder {
    const folder = this.requireFolder(id);
    const next: Folder = { ...folder, ...(req.name !== undefined ? { name: folderName(req.name) } : {}) };
    this.store.upsertFolder(next);
    this.ctx.broadcast({ type: "folder_upsert", folder: next });
    return next;
  }

  /** Delete a folder; its chats take its place in the list (nothing else is deleted). */
  deleteFolder(id: string): void {
    const folder = this.requireFolder(id);
    const inside = this.members(folder.projectId, id).map((e): Item => (e.kind === "chat" ? { kind: "chat", item: { ...e.item, folderId: null } } : e));
    const order = this.members(folder.projectId, null).flatMap((e) => (e.kind === "folder" && e.item.id === id ? inside : [e]));
    // An empty folder just goes; the others keep their numbers.
    const { workspaces, folders } = inside.length ? this.renumber(order) : { workspaces: [] as Workspace[], folders: [] as Folder[] };
    // Chats whose folder id was stale (not counted as inside) still lose it.
    for (const w of this.store.listWorkspaces()) {
      if (w.folderId === id && !workspaces.some((x) => x.id === w.id)) workspaces.push({ ...w, folderId: null });
    }
    this.store.removeFolders([id], { workspaces, folders });
    this.ctx.broadcast({ type: "folder_removed", folderId: id });
    this.push({ workspaces, folders });
  }

  /** A project's folders go with it (its chats are deleted by the caller). */
  deleteProjectFolders(projectId: string): void {
    const ids = this.store
      .listFolders()
      .filter((f) => f.projectId === projectId)
      .map((f) => f.id);
    if (!ids.length) return;
    this.store.removeFolders(ids);
    for (const folderId of ids) this.ctx.broadcast({ type: "folder_removed", folderId });
  }

  /** The folder a new chat of `projectId` (null = standalone) may start in (I-215); 400 otherwise. */
  requireFolderFor(projectId: string | null, folderId: string): Folder {
    const folder = this.store.getFolder(folderId);
    if (!folder) throw new HttpError(400, "That folder doesn't exist");
    if (folder.projectId !== projectId) {
      throw new HttpError(400, projectId === null ? "Standalone chats can only go in Chats folders" : "A chat can only go in a folder of its own project");
    }
    return folder;
  }

  /**
   * Move a chat into a folder of its list (to the folder's top) or out of one (`null`: right
   * after the folder). Returns the chat as it should be saved; other chats and folders that had
   * to be renumbered are saved here.
   */
  moveWorkspace(workspace: Workspace, folderId: string | null): Workspace {
    const from = this.folderOf(workspace);
    if (folderId !== null) {
      const folder = this.requireFolder(folderId);
      if (folder.projectId !== workspace.projectId) {
        throw new HttpError(400, workspace.projectId === null ? "Standalone chats can only go in Chats folders" : "A chat can only go in a folder of its own project");
      }
      if (from === folderId) return { ...workspace, folderId };
      return { ...workspace, folderId, sortOrder: topSortOrder(this.members(workspace.projectId, folderId).map((e) => e.item)) };
    }
    if (from === null) return { ...workspace, folderId: null };
    const moved: Workspace = { ...workspace, folderId: null };
    const order = this.members(workspace.projectId, null);
    order.splice(order.findIndex((e) => e.item.id === from) + 1, 0, { kind: "chat", item: moved });
    const changes = this.renumber(order);
    const others = { workspaces: changes.workspaces.filter((w) => w.id !== workspace.id), folders: changes.folders };
    this.save(others);
    return { ...moved, sortOrder: order.findIndex((e) => e.item.id === workspace.id) };
  }

  /** `sortOrder` for a chat arriving at the top of its list's top level (new, or unpinned). */
  topOfList(projectId: string | null, exceptId?: string): number {
    return topSortOrder(
      this.members(projectId, null)
        .filter((e) => e.item.id !== exceptId && !(e.kind === "chat" && e.item.pinned))
        .map((e) => e.item),
    );
  }

  /** The top of the container a chat is in (its folder, else its list's top level), without it. */
  topOfContainer(workspace: Workspace): number {
    const folderId = this.folderOf(workspace);
    if (folderId === null) return this.topOfList(workspace.projectId, workspace.id);
    return topSortOrder(
      this.members(workspace.projectId, folderId)
        .filter((e) => e.item.id !== workspace.id && !(e.kind === "chat" && e.item.pinned))
        .map((e) => e.item),
    );
  }

  /** `PUT /workspaces/order` (I-202): rewrite one container's order (see `ReorderChatListRequest`). */
  reorderChatList(req: ReorderChatListRequest): ReorderChatListResponse {
    const { projectId, folderId, ids } = req;
    if (projectId !== null) this.records.requireProject(projectId);
    if (folderId !== null) {
      const folder = this.requireFolder(folderId);
      if (folder.projectId !== projectId) throw new HttpError(400, "That folder isn't in this list");
    }
    if (new Set(ids).size !== ids.length) throw new HttpError(400, "ids must not repeat");
    const order: Item[] = ids.map((id): Item => {
      const workspace = this.store.getWorkspace(id);
      if (workspace) {
        if (workspace.projectId !== projectId) throw new HttpError(400, `Chat ${id} isn't in this list`);
        return { kind: "chat", item: { ...workspace, folderId } };
      }
      const folder = this.store.getFolder(id);
      if (!folder) throw new HttpError(404, `Unknown chat or folder: ${id}`);
      if (folder.projectId !== projectId) throw new HttpError(400, `Folder ${id} isn't in this list`);
      if (folderId !== null) throw new HttpError(400, "Folders can't go in folders");
      return { kind: "folder", item: folder };
    });
    const listed = new Set(ids);
    const missing = this.members(projectId, folderId).filter((e) => !listed.has(e.item.id) && !(e.kind === "chat" && e.item.pinned));
    if (missing.length) throw new HttpError(400, "ids must list every unpinned chat (and, at the top level, every folder) of that container");
    const changes = this.renumber(order);
    this.save(changes);
    const members = this.members(projectId, folderId);
    return {
      workspaces: members.flatMap((e) => (e.kind === "chat" ? [this.records.summarizeWorkspace(e.item)] : [])),
      folders: members.flatMap((e) => (e.kind === "folder" ? [e.item] : [])),
    };
  }

  // ---------------------------------------------------------------------------------------------

  /** The folder a chat counts as in: an existing folder of its own list, else null. */
  folderOf(workspace: Workspace): string | null {
    if (!workspace.folderId) return null;
    const folder = this.store.getFolder(workspace.folderId);
    return folder && folder.projectId === workspace.projectId ? folder.id : null;
  }

  /** A container's chats (and, at the top level, the list's folders) in display order. */
  private members(projectId: string | null, folderId: string | null): Item[] {
    const chats = this.store
      .listWorkspaces()
      .filter((w) => w.projectId === projectId && this.folderOf(w) === folderId)
      .map((item): Item => ({ kind: "chat", item }));
    const folders =
      folderId === null
        ? this.store
            .listFolders()
            .filter((f) => f.projectId === projectId)
            .map((item): Item => ({ kind: "folder", item }))
        : [];
    return [...chats, ...folders].sort(byPlace);
  }

  /** `sortOrder` = index for every item; returns the records that changed (with their other edits). */
  private renumber(order: readonly Item[]): { workspaces: Workspace[]; folders: Folder[] } {
    const workspaces: Workspace[] = [];
    const folders: Folder[] = [];
    order.forEach((e, sortOrder) => {
      if (e.kind === "chat") {
        const stored = this.store.getWorkspace(e.item.id);
        if (stored?.sortOrder !== sortOrder || (stored.folderId ?? null) !== (e.item.folderId ?? null)) workspaces.push({ ...e.item, sortOrder });
      } else if (e.item.sortOrder !== sortOrder) {
        folders.push({ ...e.item, sortOrder });
      }
    });
    return { workspaces, folders };
  }

  private save(changes: { folders?: Folder[]; workspaces?: Workspace[] }): void {
    if (!changes.folders?.length && !changes.workspaces?.length) return;
    this.store.saveSidebar(changes);
    this.push(changes);
  }

  private push(changes: { folders?: Folder[]; workspaces?: Workspace[] }): void {
    for (const f of changes.folders ?? []) {
      const folder = this.store.getFolder(f.id);
      if (folder) this.ctx.broadcast({ type: "folder_upsert", folder });
    }
    for (const w of changes.workspaces ?? []) {
      const workspace = this.store.getWorkspace(w.id);
      if (workspace) this.ctx.broadcast({ type: "workspace_upsert", workspace: this.records.summarizeWorkspace(workspace) });
    }
  }
}

/** A trimmed, non-empty folder name (400 otherwise). */
function folderName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new HttpError(400, "A folder name is required");
  if (name.length > MAX_FOLDER_NAME) throw new HttpError(400, `A folder name can be at most ${MAX_FOLDER_NAME} characters`);
  return name;
}
