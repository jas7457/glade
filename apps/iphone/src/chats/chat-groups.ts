/**
 * The iPhone chat list's data (I-164, doc §5.2): every connected Mac's chats in one list, grouped
 * like the desktop sidebar (projects in their manual order, each with its chats pinned first, then
 * the standalone chats), filtered by a search query. Pure: reads the shared store only.
 *
 * Folders (I-165): top-level folders sit in the project order and hold projects and standalone
 * chats (`kind: "folder"`); a project lists its folders (each with its chats) before its other
 * chats. While searching, only folders and projects with matching chats are kept.
 */
import type { Folder, Project, WorkspaceSummary } from "@glade/protocol";
import { foldersForProject, looseWorkspaces, sidebarEntries, workspacesInFolder } from "@/state/store";

/** A project's folder and the chats in it. */
export interface FolderChats {
  folder: Folder;
  chats: WorkspaceSummary[];
}

/** A project with its folders and its chats outside them. */
export interface ProjectGroup {
  kind: "project";
  key: string;
  project: Project;
  folders: FolderChats[];
  chats: WorkspaceSummary[];
}

export type ChatGroup =
  | ProjectGroup
  | { kind: "folder"; key: string; folder: Folder; projects: ProjectGroup[]; chats: WorkspaceSummary[] }
  | { kind: "standalone"; key: string; chats: WorkspaceSummary[] };

/** Case-insensitive match of every word of `query` against the chat title. */
export function matchesQuery(title: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const t = (title || "Untitled").toLowerCase();
  return words.every((w) => t.includes(w));
}

/** Every chat of a project group (in its folders or not). */
export function allChatsOf(group: ProjectGroup): WorkspaceSummary[] {
  return [...group.folders.flatMap((f) => f.chats), ...group.chats];
}

function projectGroup(project: Project, query: string): ProjectGroup | null {
  const searching = query.trim().length > 0;
  const match = (list: WorkspaceSummary[]) => list.filter((c) => matchesQuery(c.title, query));
  const folders = foldersForProject(project.id)
    .map((folder) => ({ folder, chats: match(workspacesInFolder(folder.id)) }))
    .filter((f) => !searching || f.chats.length > 0);
  const chats = match(looseWorkspaces(project.id));
  if (searching && chats.length === 0 && folders.length === 0) return null;
  return { kind: "project", key: `p:${project.environmentId ?? ""}:${project.id}`, project, folders, chats };
}

/**
 * Groups for the list. Without a query every project and folder is listed (even empty ones, like
 * the sidebar); with a query only groups with matching chats.
 */
export function chatGroups(query = ""): ChatGroup[] {
  const searching = query.trim().length > 0;
  const out: ChatGroup[] = [];
  for (const entry of sidebarEntries.value) {
    if (entry.kind === "project") {
      const group = projectGroup(entry.project, query);
      if (group) out.push(group);
      continue;
    }
    const { folder } = entry;
    const projects = entry.projects.flatMap((p) => projectGroup(p, query) ?? []);
    const chats = workspacesInFolder(folder.id).filter((c) => matchesQuery(c.title, query));
    if (searching && projects.length === 0 && chats.length === 0) continue;
    out.push({ kind: "folder", key: `f:${folder.environmentId ?? ""}:${folder.id}`, folder, projects, chats });
  }
  const standalone = looseWorkspaces(null).filter((c) => matchesQuery(c.title, query));
  if (standalone.length > 0) out.push({ kind: "standalone", key: "standalone", chats: standalone });
  return out;
}
