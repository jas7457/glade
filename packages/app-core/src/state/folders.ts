/**
 * Folders in the chat list (I-165): the pure part of how the sidebar (and the iPhone list) groups
 * projects and chats into folders. `store.ts` feeds it the signals; the tree is recomputed there.
 *
 * - The top level is projects that aren't in a folder plus top-level folders, each environment in
 *   its server's order (`sortOrder`, shared by both kinds), interleaved across environments like
 *   the project list (`env-order.ts`). Each folder lists its projects (by `sortOrder`).
 * - A project lists its folders first (by `sortOrder`), then the chats not in one.
 * - A membership only counts when the folder exists in the same environment and fits (a
 *   top-level folder for projects and standalone chats, the chat's own project's folder
 *   otherwise); anything else shows outside, so a stale id never hides a row.
 *
 * Portable client core (F-022).
 */
import { compareFolders, type Folder, type Project, type Workspace } from "@glade/protocol";
import { interleave, type OrderKey } from "./env-order";

export type TopEntry = { kind: "project"; project: Project } | { kind: "folder"; folder: Folder; projects: Project[] };

type EnvOf = (item: { environmentId?: string }) => string;

/** Id of an entry (project or folder id). */
export const entryId = (e: TopEntry): string => (e.kind === "project" ? e.project.id : e.folder.id);

/** The folder `folderId` names when it exists in the item's environment (else `undefined`). */
function lookup(foldersById: ReadonlyMap<string, Folder>, item: { folderId?: string | null; environmentId?: string }, envOf: EnvOf): Folder | undefined {
  if (!item.folderId) return undefined;
  const folder = foldersById.get(item.folderId);
  return folder && envOf(folder) === envOf(item) ? folder : undefined;
}

/** The top-level folder a project is in, or null. */
export function projectFolderId(project: Project, foldersById: ReadonlyMap<string, Folder>, envOf: EnvOf): string | null {
  const folder = lookup(foldersById, project, envOf);
  return folder && folder.projectId === null ? folder.id : null;
}

/** The folder a chat is in (a top-level one for standalone chats, its project's otherwise), or null. */
export function workspaceFolderId(workspace: Pick<Workspace, "folderId" | "projectId"> & { environmentId?: string }, foldersById: ReadonlyMap<string, Folder>, envOf: EnvOf): string | null {
  const folder = lookup(foldersById, workspace, envOf);
  return folder && folder.projectId === workspace.projectId ? folder.id : null;
}

const byOrder = (a: { sortOrder?: number; createdAt: number; id: string }, b: { sortOrder?: number; createdAt: number; id: string }) =>
  (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);

/**
 * The top level of the project list: projects outside folders and top-level folders (with their
 * projects), each environment in its order, interleaved by the device's `slots`.
 */
export function buildTopLevel(
  projects: readonly Project[],
  folders: readonly Folder[],
  slots: readonly OrderKey[],
  envOrder: readonly string[],
  envOf: EnvOf,
): TopEntry[] {
  const foldersById = new Map(folders.map((f) => [f.id, f]));
  const perEnv = new Map<string, Array<{ sort: { sortOrder?: number; createdAt: number; id: string }; entry: TopEntry }>>();
  const add = (env: string, sort: { sortOrder?: number; createdAt: number; id: string }, entry: TopEntry) => {
    const list = perEnv.get(env);
    if (list) list.push({ sort, entry });
    else perEnv.set(env, [{ sort, entry }]);
  };
  const children = new Map<string, Project[]>();
  for (const folder of folders) {
    if (folder.projectId !== null) continue;
    const inside: Project[] = [];
    children.set(folder.id, inside);
    add(envOf(folder), folder, { kind: "folder", folder, projects: inside });
  }
  for (const project of projects) {
    const folderId = projectFolderId(project, foldersById, envOf);
    if (folderId) children.get(folderId)!.push(project);
    else add(envOf(project), project, { kind: "project", project });
  }
  for (const list of children.values()) list.sort(byOrder);
  const sorted = new Map([...perEnv].map(([env, list]) => [env, list.sort((a, b) => byOrder(a.sort, b.sort)).map((x) => x.entry)]));
  return interleave(slots, sorted, envOrder);
}

/** Every project in sidebar order (folders' projects in their place). */
export function flattenProjects(entries: readonly TopEntry[]): Project[] {
  return entries.flatMap((e) => (e.kind === "project" ? [e.project] : e.projects));
}

/** One project's folders in their order. */
export function foldersOfProject(folders: readonly Folder[], projectId: string): Folder[] {
  return folders.filter((f) => f.projectId === projectId).sort(compareFolders);
}

/**
 * The ids a server's `PUT /projects/order` needs for one environment: its top-level entries in
 * the given order, each folder followed by its projects.
 */
export function flatOrder(entries: readonly TopEntry[]): string[] {
  return entries.flatMap((e) => (e.kind === "project" ? [e.project.id] : [e.folder.id, ...e.projects.map((p) => p.id)]));
}

// Dragging in the project list ------------------------------------------------------------------

/** One rendered row of the project list: a top-level project or folder, or a project inside a folder. */
export interface TreeRow {
  id: string;
  kind: "project" | "folder";
  /** The folder a project row is in (null at the top level). */
  parent: string | null;
}

export interface TreeDrop {
  /** Top-level entry ids in their new order. */
  top: string[];
  /** Each folder's project ids in their new order (folders whose list changed or not). */
  inside: Record<string, string[]>;
  /** The dragged project's new folder, when it changed. */
  moved?: { id: string; folderId: string | null };
}

/**
 * Where a drop in the project list leaves everything. `rows` are the rendered rows before the
 * drag (document order: a folder row is followed by its projects' rows while it's open),
 * `order` the same ids after the move, `draggedId` what moved.
 *
 * A project lands in a folder when it's dropped right below the folder's row (an open folder), or
 * between two of its projects; below a folder's last project it's back at the top level, unless
 * it came from that folder (reordering to the end). A folder never lands inside another one: it
 * goes after that folder's projects. Rows that weren't rendered (a closed folder's projects)
 * keep their folder.
 */
export function resolveTreeDrop(rows: readonly TreeRow[], order: readonly string[], draggedId: string, openFolders: ReadonlySet<string>): TreeDrop {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const dragged = byId.get(draggedId);
  const seq = order.filter((id) => byId.has(id));
  let parentOf = (id: string) => byId.get(id)!.parent;
  if (dragged?.kind === "folder") {
    // Its projects move with it; it can't land inside another folder's block.
    const own = seq.filter((id) => byId.get(id)!.parent === draggedId);
    const rest = seq.filter((id) => byId.get(id)!.parent !== draggedId);
    let at = rest.indexOf(draggedId);
    rest.splice(at, 1);
    while (at > 0 && at < rest.length && byId.get(rest[at]!)!.parent !== null) at++;
    rest.splice(at, 0, draggedId, ...own);
    seq.splice(0, seq.length, ...rest);
  } else if (dragged) {
    const at = seq.indexOf(draggedId);
    const prev = at > 0 ? byId.get(seq[at - 1]!)! : null;
    const next = at < seq.length - 1 ? byId.get(seq[at + 1]!)! : null;
    let parent: string | null = null;
    if (prev?.kind === "folder" && openFolders.has(prev.id)) parent = prev.id;
    else if (prev?.parent && next?.parent === prev.parent) parent = prev.parent;
    else if (prev?.parent && prev.parent === dragged.parent) parent = prev.parent;
    const before = parentOf;
    parentOf = (id: string) => (id === draggedId ? parent : before(id));
  }
  const top: string[] = [];
  const inside: Record<string, string[]> = {};
  for (const row of rows) if (row.kind === "folder") inside[row.id] = [];
  for (const id of seq) {
    const row = byId.get(id)!;
    const parent = row.kind === "folder" ? null : parentOf(id);
    if (parent === null) top.push(id);
    else (inside[parent] ??= []).push(id);
  }
  const result: TreeDrop = { top, inside };
  if (dragged?.kind === "project" && parentOf(draggedId) !== dragged.parent) result.moved = { id: draggedId, folderId: parentOf(draggedId) };
  return result;
}
