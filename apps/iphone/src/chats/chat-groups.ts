/**
 * The iPhone chat list's data (I-164, doc §5.2): every connected Mac's chats in one list, grouped
 * like the desktop sidebar (projects in their manual order, then the standalone chats), filtered
 * by a search query. Pure: reads the shared store only.
 *
 * Each list (a project's, or the standalone Chats section) is `chatListOf`'s (I-202): pinned chats
 * first, then one manual order of chats and folders mixed, each folder with its chats; projects
 * are always top level. While searching, only matching chats, the folders holding them, and the
 * projects with matches are kept.
 */
import type { Folder, Project, WorkspaceSummary } from "@glade/protocol";
import { chatListOf, sortedProjects } from "@glade/app-core/state/store";

/** One entry of a list's mixed order. */
export type ListEntry = { kind: "chat"; chat: WorkspaceSummary } | { kind: "folder"; folder: Folder; chats: WorkspaceSummary[] };

/** A list as shown: its pinned chats outside folders, then the mixed order. */
export interface ListRows {
  pinned: WorkspaceSummary[];
  entries: ListEntry[];
}

/** A project with its list. */
export interface ProjectGroup extends ListRows {
  kind: "project";
  key: string;
  project: Project;
}

export type ChatGroup = ProjectGroup | ({ kind: "standalone"; key: string } & ListRows);

/** Case-insensitive match of every word of `query` against the chat title. */
export function matchesQuery(title: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const t = (title || "Untitled").toLowerCase();
  return words.every((w) => t.includes(w));
}

/** Every chat of a list (pinned, then in order with folders' chats in place). */
export function allChatsOf(rows: ListRows): WorkspaceSummary[] {
  return [...rows.pinned, ...rows.entries.flatMap((e) => (e.kind === "chat" ? [e.chat] : e.chats))];
}

/** A list filtered by `query`; null when searching found nothing in it. */
function listRows(projectId: string | null, query: string): ListRows | null {
  const searching = query.trim().length > 0;
  const view = chatListOf(projectId);
  const match = (c: WorkspaceSummary) => matchesQuery(c.title, query);
  const pinned = view.pinned.filter(match);
  const entries = view.entries.flatMap((e): ListEntry[] => {
    if (e.kind === "chat") return match(e.chat) ? [e] : [];
    const chats = e.chats.filter(match);
    return !searching || chats.length > 0 ? [{ kind: "folder", folder: e.folder, chats }] : [];
  });
  if (searching && pinned.length === 0 && entries.length === 0) return null;
  return { pinned, entries };
}

/**
 * Groups for the list. Without a query every project is listed (even empty ones, like the
 * sidebar) and the Chats section when it has anything; with a query only groups with matches.
 */
export function chatGroups(query = ""): ChatGroup[] {
  const out: ChatGroup[] = [];
  for (const project of sortedProjects.value) {
    const rows = listRows(project.id, query);
    if (rows) out.push({ kind: "project", key: `p:${project.environmentId ?? ""}:${project.id}`, project, ...rows });
  }
  const standalone = listRows(null, query);
  if (standalone && (standalone.pinned.length > 0 || standalone.entries.length > 0)) out.push({ kind: "standalone", key: "standalone", ...standalone });
  return out;
}
