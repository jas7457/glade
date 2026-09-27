/**
 * Opt-in git worktree per workspace (I-096). A workspace created with
 * `CreateWorkspaceRequest.worktree: true` works on its own branch in its own folder
 * (`Workspace.worktree`, `Workspace.cwd`); deleting it asks what to do with that branch.
 *
 *   GET    /api/projects/:id/git                      → ProjectGitInfo
 *   POST   /api/projects/:id/git/checkout             → ProjectGitInfo  (CheckoutBranchRequest; I-105)
 *   POST   /api/projects/:id/git/branch               → ProjectGitInfo  (CreateBranchRequest; I-105)
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

/** A local branch of a project's repository (the new-chat branch picker, I-105). */
export interface ProjectBranch {
  name: string;
  /** Checked out in the project folder. */
  current: boolean;
  /** The repository's default branch (`origin/HEAD`, else `main`/`master`). */
  isDefault: boolean;
  /** Last commit's committer date (ms since epoch). */
  committedAt: number;
}

/** Most branches `ProjectGitInfo.branches` lists. */
export const PROJECT_BRANCHES_MAX = 200;
/** Most paths `ProjectGitInfo.uncommittedPaths` lists. */
export const UNCOMMITTED_PATHS_MAX = 20;

/** Whether a project folder can have worktree chats, and its branches (I-096, I-105). */
export interface ProjectGitInfo {
  /** The folder is (inside) a git repository with at least one commit. */
  isRepo: boolean;
  /** Its current branch; `null` when detached or not a repo. */
  branch: string | null;
  /**
   * Local branches: the current one, the default one, then by last commit (newest first);
   * at most `PROJECT_BRANCHES_MAX`. Empty when not a repo.
   */
  branches: ProjectBranch[];
  /** Changed, added, deleted or untracked files in the repository's main folder. */
  uncommittedFiles: number;
  /** The first `UNCOMMITTED_PATHS_MAX` of them (repo-relative). */
  uncommittedPaths: string[];
}

/**
 * `POST /api/projects/:id/git/checkout`: check out a local branch in the project folder. 409 when
 * the folder has uncommitted changes or a chat of the project is working in it.
 */
export interface CheckoutBranchRequest {
  branch: string;
}

/**
 * `POST /api/projects/:id/git/branch`: create a branch from the current HEAD, and check it out
 * when `checkout` (uncommitted changes stay with it). 400 for an invalid name, 409 when it exists
 * (or, with `checkout`, while a chat of the project is working in the folder).
 */
export interface CreateBranchRequest {
  name: string;
  checkout?: boolean;
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
