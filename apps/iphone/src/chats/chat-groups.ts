/**
 * The iPhone chat list's data (I-164, doc §5.2): every connected Mac's chats in one list, grouped
 * like the desktop sidebar (projects in their manual order, each with its chats pinned first, then
 * the standalone chats), filtered by a search query. Pure: reads the shared store only.
 */
import type { Project, WorkspaceSummary } from "@glade/protocol";
import { sortedProjects, workspacesForProject } from "@/state/store";

export type ChatGroup =
  | { kind: "project"; key: string; project: Project; chats: WorkspaceSummary[] }
  | { kind: "standalone"; key: string; chats: WorkspaceSummary[] };

/** Case-insensitive match of every word of `query` against the chat title. */
export function matchesQuery(title: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const t = (title || "Untitled").toLowerCase();
  return words.every((w) => t.includes(w));
}

/**
 * Groups for the list. Without a query every project is listed (even empty ones, like the
 * sidebar); with a query only groups with matching chats.
 */
export function chatGroups(query = ""): ChatGroup[] {
  const searching = query.trim().length > 0;
  const out: ChatGroup[] = [];
  for (const project of sortedProjects.value) {
    const chats = workspacesForProject(project.id).filter((c) => matchesQuery(c.title, query));
    if (searching && chats.length === 0) continue;
    out.push({ kind: "project", key: `p:${project.environmentId ?? ""}:${project.id}`, project, chats });
  }
  const standalone = workspacesForProject(null).filter((c) => matchesQuery(c.title, query));
  if (standalone.length > 0) out.push({ kind: "standalone", key: "standalone", chats: standalone });
  return out;
}
