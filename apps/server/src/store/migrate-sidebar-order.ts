/**
 * One-time sidebar order migration (I-202), run by the store when it opens (`meta`
 * `sidebar_order` unset). Turns what the sidebar showed before I-202 into the new manual order:
 *
 * - **Chat lists**: each container's visual order becomes its `sortOrder` 0..n−1. A list's top
 *   level showed its pinned chats (`pinOrder`), then its folders (`Folder.sortOrder`), then its
 *   other chats newest first; a folder showed its pinned chats, then the rest newest first.
 * - **Chats-section folders**: folders without a project used to sit in the project list (and
 *   could hold projects). They become folders of the standalone Chats section, in their previous
 *   relative order, above its unpinned chats (like a project's folders were).
 * - **Projects**: `folderId` is dropped (projects are always top level). When any project was in
 *   a folder or any project-less folder existed, projects are renumbered in the order they were
 *   shown (each folder's projects at the folder's place); otherwise their order is untouched.
 *
 * Pure: returns only the records that change.
 */
import { compareFolders, type Folder, type Project, type Workspace } from "@glade/protocol";

export const SIDEBAR_ORDER_META_KEY = "sidebar_order";

export interface SidebarRecords {
  projects: readonly Project[];
  workspaces: readonly Workspace[];
  folders: readonly Folder[];
}

export interface SidebarChanges {
  projects: Project[];
  workspaces: Workspace[];
  folders: Folder[];
}

type Legacy<T> = T & { folderId?: string | null };

const newestFirst = (a: Workspace, b: Workspace) => b.createdAt - a.createdAt || a.id.localeCompare(b.id);
const byPinOrder = (a: Workspace, b: Workspace) => (a.pinOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinOrder ?? Number.MAX_SAFE_INTEGER) || newestFirst(a, b);
/** The server's pre-I-202 order of projects and top-level folders (oldest first on ties). */
const oldOrder = (a: { sortOrder?: number; createdAt: number; id: string }, b: { sortOrder?: number; createdAt: number; id: string }) =>
  (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.createdAt - b.createdAt || a.id.localeCompare(b.id);

export function migrateSidebarOrder(records: SidebarRecords): SidebarChanges {
  const folders = new Map(records.folders.map((f) => [f.id, f]));
  const changedWorkspaces = new Map<string, Workspace>();
  const changedFolders = new Map<string, Folder>();

  // Projects ----------------------------------------------------------------------------------
  const projects = records.projects as ReadonlyArray<Legacy<Project>>;
  const topFolders = records.folders.filter((f) => f.projectId === null);
  const changedProjects: Project[] = [];
  if (topFolders.length > 0 || projects.some((p) => p.folderId)) {
    const inFolder = (p: Legacy<Project>) => (p.folderId && folders.get(p.folderId)?.projectId === null ? p.folderId : null);
    const top = [
      ...projects.filter((p) => !inFolder(p)).map((p) => ({ sort: p as { sortOrder?: number; createdAt: number; id: string }, projects: [p] })),
      ...topFolders.map((f) => ({ sort: f, projects: projects.filter((p) => inFolder(p) === f.id).sort(oldOrder) })),
    ].sort((a, b) => oldOrder(a.sort, b.sort));
    top.flatMap((e) => e.projects).forEach((p, sortOrder) => {
      const { folderId, ...rest } = p;
      if (folderId !== undefined || p.sortOrder !== sortOrder) changedProjects.push({ ...rest, sortOrder });
    });
  } else {
    for (const p of projects) {
      if (!("folderId" in p)) continue;
      const { folderId: _drop, ...rest } = p;
      changedProjects.push(rest);
    }
  }

  // Chat lists --------------------------------------------------------------------------------
  const setWorkspace = (w: Workspace, sortOrder: number) => {
    if (w.sortOrder !== sortOrder) changedWorkspaces.set(w.id, { ...w, sortOrder });
  };
  const lists = new Map<string | null, Workspace[]>();
  for (const w of records.workspaces) {
    const list = lists.get(w.projectId);
    if (list) list.push(w);
    else lists.set(w.projectId, [w]);
  }
  for (const f of records.folders) if (!lists.has(f.projectId)) lists.set(f.projectId, []);
  for (const [projectId, chats] of lists) {
    const listFolders = records.folders.filter((f) => f.projectId === projectId).sort(compareFolders);
    const folderOf = (w: Workspace) => (w.folderId && folders.get(w.folderId)?.projectId === projectId ? w.folderId : null);
    const loose = chats.filter((w) => folderOf(w) === null);
    const top: Array<{ kind: "chat"; item: Workspace } | { kind: "folder"; item: Folder }> = [
      ...loose.filter((w) => w.pinned).sort(byPinOrder).map((item) => ({ kind: "chat" as const, item })),
      ...listFolders.map((item) => ({ kind: "folder" as const, item })),
      ...loose.filter((w) => !w.pinned).sort(newestFirst).map((item) => ({ kind: "chat" as const, item })),
    ];
    top.forEach((e, sortOrder) => {
      if (e.kind === "chat") setWorkspace(e.item, sortOrder);
      else if (e.item.sortOrder !== sortOrder) changedFolders.set(e.item.id, { ...e.item, sortOrder });
    });
    for (const folder of listFolders) {
      const inside = chats.filter((w) => folderOf(w) === folder.id);
      [...inside.filter((w) => w.pinned).sort(byPinOrder), ...inside.filter((w) => !w.pinned).sort(newestFirst)].forEach((w, i) => setWorkspace(w, i));
    }
  }

  return { projects: changedProjects, workspaces: [...changedWorkspaces.values()], folders: [...changedFolders.values()] };
}
