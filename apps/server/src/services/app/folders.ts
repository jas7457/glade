/**
 * Folders in the chat list (I-165; types and rules in `@glade/protocol` folders.ts): create,
 * rename, reorder, delete (members move out), and moving projects and chats in and out.
 *
 * Top-level folders share the project list's manual order (`sortOrder`): the "sidebar order" is
 * the projects and top-level folders sorted by `sortOrder`, each folder followed by its projects
 * (also by `sortOrder`). Changes that move things between lists renumber that whole order 0..n−1
 * (only records whose number changed are written and pushed).
 */
import { compareFolders, MAX_FOLDER_NAME, type CreateFolderRequest, type Folder, type Project, type UpdateFolderRequest, type Workspace } from "@glade/protocol";
import { ulid } from "../../store/db/ids.js";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";
import type { Records } from "./records.js";
import { sameIdSet } from "./workspaces.js";

type Entry = { kind: "project"; item: Project } | { kind: "folder"; item: Folder };

const byOrder = (a: Entry, b: Entry) =>
  (a.item.sortOrder ?? 0) - (b.item.sortOrder ?? 0) || a.item.createdAt - b.item.createdAt || a.item.id.localeCompare(b.item.id);

export class Folders {
  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
  ) {}

  private get store() {
    return this.ctx.store;
  }

  /** Every folder: top-level ones first, then by project; each list in its manual order. */
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
    const orders =
      projectId === null
        ? this.topLevel().map((e) => e.item.sortOrder ?? 0)
        : this.projectFolders(projectId).map((f) => f.sortOrder);
    const folder: Folder = {
      id: ulid(),
      name,
      projectId,
      // New folders go to the top of their list, like new projects.
      sortOrder: orders.length ? Math.min(...orders) - 1 : 0,
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

  /** Reorder one project's folders. `ids` must be exactly that project's folders. */
  reorderFolders(projectId: string, ids: string[]): Folder[] {
    this.records.requireProject(projectId);
    if (!sameIdSet(ids, this.projectFolders(projectId).map((f) => f.id))) {
      throw new HttpError(400, "ids must list every folder of that project exactly once");
    }
    const changed = ids.flatMap((id, sortOrder) => {
      const folder = this.store.getFolder(id)!;
      return folder.sortOrder === sortOrder ? [] : [{ ...folder, sortOrder }];
    });
    this.save({ folders: changed });
    return this.projectFolders(projectId);
  }

  /**
   * Delete a folder; what was in it moves out (nothing else is deleted). A top-level folder's
   * projects take its place in the project list.
   */
  deleteFolder(id: string): void {
    const folder = this.requireFolder(id);
    const workspaces = this.store
      .listWorkspaces()
      .filter((w) => w.folderId === id)
      .map((w) => ({ ...w, folderId: null }));
    let projects: Project[] = [];
    if (folder.projectId === null) {
      const order = this.sidebarOrder().filter((e) => !(e.kind === "folder" && e.item.id === id));
      projects = this.renumber(order.map((e) => (e.kind === "project" && e.item.folderId === id ? { ...e, item: { ...e.item, folderId: null } } : e))).projects;
      for (const p of this.store.listProjects()) {
        if (p.folderId === id && !projects.some((q) => q.id === p.id)) projects.push({ ...p, folderId: null });
      }
    }
    this.store.removeFolders([id], { projects, workspaces });
    this.ctx.broadcast({ type: "folder_removed", folderId: id });
    this.pushMembers(projects, workspaces);
  }

  /** A project's folders go with it (its chats are deleted by the caller). */
  deleteProjectFolders(projectId: string): void {
    const ids = this.projectFolders(projectId).map((f) => f.id);
    if (!ids.length) return;
    this.store.removeFolders(ids);
    for (const folderId of ids) this.ctx.broadcast({ type: "folder_removed", folderId });
  }

  /** Move a project into a top-level folder (at its top) or out of one (right after it). */
  moveProject(projectId: string, folderId: string | null): Project {
    const project = this.records.requireProject(projectId);
    const from = project.folderId ?? null;
    if (folderId !== null) {
      const folder = this.requireFolder(folderId);
      if (folder.projectId !== null) throw new HttpError(400, "Projects can only go in top-level folders");
    }
    if ((from && this.store.getFolder(from) ? from : null) === folderId) {
      if (from !== folderId) return this.saveOne({ ...project, folderId });
      return project;
    }
    const order = this.sidebarOrder().filter((e) => e.item.id !== projectId);
    const moved: Entry = { kind: "project", item: { ...project, folderId } };
    if (folderId !== null) {
      order.splice(order.findIndex((e) => e.item.id === folderId) + 1, 0, moved);
    } else {
      // Right after the folder it was in (and that folder's other projects).
      let at = order.findIndex((e) => e.item.id === from);
      while (at !== -1 && order[at + 1]?.kind === "project" && (order[at + 1]!.item as Project).folderId === from) at++;
      order.splice(at === -1 ? 0 : at + 1, 0, moved);
    }
    const { projects, folders } = this.renumber(order);
    this.save({ projects, folders });
    return this.store.getProject(projectId)!;
  }

  /** Move a chat into a folder (a top-level one for standalone chats, its project's otherwise) or out. */
  moveWorkspace(workspace: Workspace, folderId: string | null): Workspace {
    if (folderId !== null) {
      const folder = this.requireFolder(folderId);
      if (folder.projectId !== workspace.projectId) {
        throw new HttpError(400, workspace.projectId === null ? "Standalone chats can only go in top-level folders" : "A chat can only go in a folder of its own project");
      }
    }
    return { ...workspace, folderId };
  }

  /**
   * `PUT /projects/order` (I-165: folder ids allowed): every project exactly once, plus any
   * top-level folders; all get `sortOrder` = their index.
   */
  reorderSidebar(ids: string[]): void {
    const projects = this.store.listProjects();
    const projectIds = new Set(projects.map((p) => p.id));
    const listedProjects = ids.filter((id) => projectIds.has(id));
    const listedFolders = ids.filter((id) => !projectIds.has(id));
    if (new Set(ids).size !== ids.length || !sameIdSet(listedProjects, [...projectIds])) {
      throw new HttpError(400, "ids must list every project exactly once");
    }
    for (const id of listedFolders) {
      if (this.store.getFolder(id)?.projectId !== null) throw new HttpError(400, `Unknown top-level folder: ${id}`);
    }
    const changedProjects: Project[] = [];
    const changedFolders: Folder[] = [];
    ids.forEach((id, sortOrder) => {
      const project = this.store.getProject(id);
      if (project) {
        if (project.sortOrder !== sortOrder) changedProjects.push({ ...project, sortOrder });
        return;
      }
      const folder = this.store.getFolder(id)!;
      if (folder.sortOrder !== sortOrder) changedFolders.push({ ...folder, sortOrder });
    });
    this.save({ projects: changedProjects, folders: changedFolders });
  }

  // ---------------------------------------------------------------------------------------------

  private projectFolders(projectId: string): Folder[] {
    return this.store
      .listFolders()
      .filter((f) => f.projectId === projectId)
      .sort(compareFolders);
  }

  /** Projects not in a (known) folder and top-level folders, in order. */
  private topLevel(): Entry[] {
    const folders = new Set(this.store.listFolders().filter((f) => f.projectId === null).map((f) => f.id));
    return [
      ...this.store.listProjects().filter((p) => !p.folderId || !folders.has(p.folderId)).map((item): Entry => ({ kind: "project", item })),
      ...this.store
        .listFolders()
        .filter((f) => f.projectId === null)
        .map((item): Entry => ({ kind: "folder", item })),
    ].sort(byOrder);
  }

  /** The top level with each folder followed by its projects. */
  private sidebarOrder(): Entry[] {
    const out: Entry[] = [];
    for (const entry of this.topLevel()) {
      out.push(entry);
      if (entry.kind !== "folder") continue;
      const inside = this.store
        .listProjects()
        .filter((p) => p.folderId === entry.item.id)
        .map((item): Entry => ({ kind: "project", item }))
        .sort(byOrder);
      out.push(...inside);
    }
    return out;
  }

  /** `sortOrder` = index for every entry; returns the records that changed (with their other edits). */
  private renumber(order: Entry[]): { projects: Project[]; folders: Folder[] } {
    const projects: Project[] = [];
    const folders: Folder[] = [];
    order.forEach((entry, sortOrder) => {
      if (entry.kind === "project") {
        const stored = this.store.getProject(entry.item.id);
        if (stored?.sortOrder !== sortOrder || (stored.folderId ?? null) !== (entry.item.folderId ?? null)) projects.push({ ...entry.item, sortOrder });
      } else if (entry.item.sortOrder !== sortOrder) {
        folders.push({ ...entry.item, sortOrder });
      }
    });
    return { projects, folders };
  }

  private saveOne(project: Project): Project {
    this.save({ projects: [project] });
    return project;
  }

  private save(changes: { projects?: Project[]; folders?: Folder[]; workspaces?: Workspace[] }): void {
    if (!changes.projects?.length && !changes.folders?.length && !changes.workspaces?.length) return;
    this.store.saveSidebar(changes);
    for (const folder of changes.folders ?? []) this.ctx.broadcast({ type: "folder_upsert", folder });
    this.pushMembers(changes.projects ?? [], changes.workspaces ?? []);
  }

  private pushMembers(projects: Project[], workspaces: Workspace[]): void {
    for (const p of projects) {
      const project = this.store.getProject(p.id);
      if (project) this.ctx.broadcast({ type: "project_upsert", project });
    }
    for (const w of workspaces) {
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
