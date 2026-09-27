/**
 * Git state for new chats (I-096, I-105): each project's git info (is it a repository, its
 * branches and uncommitted files), and the new-chat context bar's "Work in" choice.
 *
 * The choice remembers nothing: `newChatWorktree` holds the project "New worktree" is on for
 * (set by the bar, or by the sidebar's "New Chat in Worktree"), `newChatWorktreeOptions` the base
 * branch / branch name picked for it; both are cleared when the new-chat screen goes away and
 * after the chat is created. `createWorkspace` asks `worktreeRequestFor` what to send.
 */
import { signal } from "@preact/signals";
import type { CreateWorkspaceRequest, ProjectGitInfo } from "@glade/protocol";
import { api } from "@/lib/api";

/** Project id "New worktree" is on for; null = Local. */
export const newChatWorktree = signal<string | null>(null);

/** Base branch and branch name for the new worktree (I-105); null fields = defaults. */
export interface NewChatWorktreeOptions {
  projectId: string;
  /** Local branch the worktree starts from; null = the project's current branch. */
  baseRef: string | null;
  /** Name of the worktree's new branch; null = `glade/<slug>`. */
  branch: string | null;
  /** Bring the project folder's uncommitted changes along (I-117); only sent while `canCarryChanges`. */
  carryChanges?: boolean;
}
export const newChatWorktreeOptions = signal<NewChatWorktreeOptions | null>(null);

/** Git info per project id, filled by `loadProjectGit`. */
export const projectGit = signal<ReadonlyMap<string, ProjectGitInfo>>(new Map());

export const NOT_A_REPO: ProjectGitInfo = { isRepo: false, branch: null, branches: [], uncommittedFiles: 0, uncommittedPaths: [] };

const loading = new Map<string, Promise<void>>();

function setGit(projectId: string, info: ProjectGitInfo): void {
  projectGit.value = new Map(projectGit.value).set(projectId, info);
}

/** Fetch (again) a project's git info. Failures count as "not a repo". */
export function loadProjectGit(projectId: string): Promise<void> {
  const pending = loading.get(projectId);
  if (pending) return pending;
  const load = Promise.resolve()
    .then(() => api.getProjectGit(projectId))
    .catch((): ProjectGitInfo => NOT_A_REPO)
    .then((info) => setGit(projectId, info))
    .finally(() => loading.delete(projectId));
  loading.set(projectId, load);
  return load;
}

/** Update the worktree options for `projectId` (keeping the other field). */
export function setWorktreeOptions(projectId: string, patch: Partial<Omit<NewChatWorktreeOptions, "projectId">>): void {
  const current = newChatWorktreeOptions.value?.projectId === projectId ? newChatWorktreeOptions.value : { projectId, baseRef: null, branch: null };
  newChatWorktreeOptions.value = { ...current, ...patch };
}

/** Back to Local with default options (the new-chat screen went away or the chat was created). */
export function resetNewChatWorktree(): void {
  newChatWorktree.value = null;
  newChatWorktreeOptions.value = null;
}

/**
 * Whether a worktree starting from `baseRef` (null = the current branch) can bring the project
 * folder's uncommitted changes (I-117): only from the folder's current branch, and only if there are any.
 */
export function canCarryChanges(git: ProjectGitInfo | undefined, baseRef: string | null | undefined): boolean {
  return !!git?.isRepo && git.uncommittedFiles > 0 && (!baseRef || baseRef === git.branch);
}

/** The worktree fields of a new chat's `CreateWorkspaceRequest` for the bar's current choice. */
export function worktreeRequestFor(projectId: string | null): Pick<CreateWorkspaceRequest, "worktree" | "baseRef" | "branch" | "carryChanges"> {
  if (projectId === null || newChatWorktree.value !== projectId) return {};
  const opts = newChatWorktreeOptions.value?.projectId === projectId ? newChatWorktreeOptions.value : null;
  return {
    worktree: true,
    ...(opts?.baseRef ? { baseRef: opts.baseRef } : {}),
    ...(opts?.branch ? { branch: opts.branch } : {}),
    ...(opts?.carryChanges && canCarryChanges(projectGit.value.get(projectId), opts.baseRef) ? { carryChanges: true } : {}),
  };
}

/** Check out a branch in the project folder; updates the project's git info. Throws `ApiRequestError`. */
export async function checkoutProjectBranch(projectId: string, branch: string): Promise<ProjectGitInfo> {
  const info = await api.checkoutProjectBranch(projectId, branch);
  setGit(projectId, info);
  return info;
}

/** Create a branch in the project folder (and check it out); updates the project's git info. */
export async function createProjectBranch(projectId: string, name: string, checkout: boolean): Promise<ProjectGitInfo> {
  const info = await api.createProjectBranch(projectId, name, checkout);
  setGit(projectId, info);
  return info;
}
