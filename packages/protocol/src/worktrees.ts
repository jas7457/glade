/**
 * Opt-in git worktree per workspace (I-096). A workspace created with
 * `CreateWorkspaceRequest.worktree: true` works on its own branch in its own folder
 * (`Workspace.worktree`, `Workspace.cwd`); deleting it asks what to do with that branch.
 *
 *   GET    /api/projects/:id/git                      → ProjectGitInfo
 *   GET    /api/workspaces/:id/worktree               → WorktreeStatus (404 without a worktree)
 *   DELETE /api/workspaces/:id?worktree=keep|merge|discard   (default keep)
 */

/**
 * What happens to a worktree workspace's branch when the workspace is deleted. The worktree
 * folder is always removed (uncommitted changes in it are lost).
 * - `keep`: the branch stays in the repository.
 * - `merge`: `git merge` the branch into its base branch in the project folder first (refused
 *   when the project folder has uncommitted changes or isn't on the base branch), then delete it.
 * - `discard`: delete the branch too.
 */
export type WorktreeRemoval = "keep" | "merge" | "discard";

export const WORKTREE_REMOVALS: readonly WorktreeRemoval[] = ["keep", "merge", "discard"];

/** Whether a project folder can have worktree chats. */
export interface ProjectGitInfo {
  /** The folder is (inside) a git repository with at least one commit. */
  isRepo: boolean;
  /** Its current branch; `null` when detached or not a repo. */
  branch: string | null;
}

/** A worktree workspace's state, shown before deleting it. */
export interface WorktreeStatus {
  branch: string;
  baseRef: string;
  /** The worktree folder still exists. */
  exists: boolean;
  /** Changed, added, deleted or untracked files not committed in the worktree (lost on delete). */
  uncommittedFiles: number;
  /** Commits on the branch that aren't in the base yet. */
  ahead: number;
  /** Why "Merge into <base>" can't run right now (e.g. the project folder has uncommitted changes); `null` = it can. */
  mergeBlocker: string | null;
}
