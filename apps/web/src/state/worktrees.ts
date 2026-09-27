/**
 * Worktree chats (I-096): which projects are git repositories (so the new-chat screen can offer
 * "New worktree"), and that switch's state. The switch is off by default and remembers nothing:
 * it holds the project it's on for, is cleared when the new-chat screen goes away, and
 * `createWorkspace` sends `worktree: true` when it's on for the new chat's project.
 */
import { signal } from "@preact/signals";
import type { ProjectGitInfo } from "@glade/protocol";
import { api } from "@/lib/api";

/** Project id the "New worktree" switch is on for; null = off. */
export const newChatWorktree = signal<string | null>(null);

/** Git info per project id, filled by `loadProjectGit`. */
export const projectGit = signal<ReadonlyMap<string, ProjectGitInfo>>(new Map());

const loading = new Map<string, Promise<void>>();

/** Fetch (again) whether a project's folder is a git repository. Failures count as "not a repo". */
export function loadProjectGit(projectId: string): Promise<void> {
  const pending = loading.get(projectId);
  if (pending) return pending;
  const load = Promise.resolve()
    .then(() => api.getProjectGit(projectId))
    .catch((): ProjectGitInfo => ({ isRepo: false, branch: null }))
    .then((info) => {
      projectGit.value = new Map(projectGit.value).set(projectId, info);
    })
    .finally(() => loading.delete(projectId));
  loading.set(projectId, load);
  return load;
}
