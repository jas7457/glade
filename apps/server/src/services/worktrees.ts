/**
 * Git worktrees for workspaces (I-096): a workspace created with "New worktree" works on its own
 * branch (`glade/<slug>`) in its own folder, `<dataDir>/worktrees/<project-slug>/<branch-slug>`
 * (inside the app's data folder rather than next to the repo, so Glade never litters the user's
 * source tree and can find/prune its own folders). Everything runs `git` via `execFile` (no shell).
 *
 * Deleting such a workspace removes the worktree folder and then keeps the branch, merges it into
 * its base branch in the project folder (only when that folder is clean and on the base branch),
 * or deletes it.
 *
 * With `carryChanges` (I-117) the project folder's uncommitted changes are brought into the new
 * worktree (`carryUncommittedChanges`); the folder keeps its copy.
 */
import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { WorkspaceWorktree, WorktreeRemoval, WorktreeStatus } from "@glade/protocol";
import { HttpError } from "./app/errors.js";
import { assertBranchName, git, isLocalBranch, ok, repoInfo } from "./project-git.js";

export { projectGitInfo } from "./project-git.js";

export const BRANCH_PREFIX = "glade/";
const SLUG_MAX = 40;

/** `Fix the sidebar!` → `fix-the-sidebar` (lowercase ASCII, dashes, ≤ 40 chars; may be empty). */
export function slugify(text: string, max = SLUG_MAX): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= max) return slug;
  const cut = slug.slice(0, max);
  const dash = cut.lastIndexOf("-");
  return (dash > max / 2 ? cut.slice(0, dash) : cut).replace(/-+$/, "");
}

export interface CreateWorktreeOptions {
  /** The project folder (the repo root or a folder inside it). */
  folder: string;
  /** Where Glade keeps worktrees (`<dataDir>/worktrees`). */
  worktreesDir: string;
  /** Names the branch (e.g. the chat's title); `fallback` when it has no usable characters. */
  name: string;
  fallback: string;
  /** Local branch to start from (I-105); default: the project's current branch (or commit, when detached). */
  baseRef?: string;
  /** Exact name for the new branch (I-105); default `glade/<slug>`, made unique. */
  branch?: string;
  /** Bring the project folder's uncommitted changes along (I-117); needs the current branch as the base. */
  carryChanges?: boolean;
}

export interface CreatedWorktree {
  worktree: WorkspaceWorktree;
  /** Where the workspace's agents run: the worktree, or the project's subfolder inside it. */
  cwd: string;
}

/**
 * Create a worktree on a new branch `glade/<slug>` (made unique) from the project's current
 * branch (or commit, when detached), or `baseRef`; or on `opts.branch`. 400 when the folder isn't a
 * git repository or has no commits, `baseRef` isn't a local branch or `branch` isn't a valid name,
 * or `carryChanges` with a base other than the current branch; 409 when `branch` already exists.
 * When carrying the changes fails, the new worktree and branch are removed again (500).
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<CreatedWorktree> {
  const info = await repoInfo(opts.folder);
  if (!info) throw new HttpError(400, `${opts.folder} isn't a git repository`);
  if (!info.hasCommits) throw new HttpError(400, "The repository has no commits yet; commit something before starting a worktree chat");
  if (opts.baseRef !== undefined && (opts.baseRef.startsWith("-") || !(await isLocalBranch(info.root, opts.baseRef)))) {
    throw new HttpError(400, `${opts.baseRef} isn't a local branch`);
  }
  if (opts.branch !== undefined) {
    await assertBranchName(info.root, opts.branch);
    if (await isLocalBranch(info.root, opts.branch)) throw new HttpError(409, `A branch named ${opts.branch} already exists`);
  }
  if (opts.carryChanges && opts.baseRef !== undefined && opts.baseRef !== info.branch) {
    throw new HttpError(400, `Uncommitted changes can only be brought along when the worktree starts from the current branch (${info.branch ?? "detached HEAD"})`);
  }
  const baseRef = opts.baseRef ?? info.branch ?? (await git(info.root, ["rev-parse", "HEAD"])).trim();
  const slug = (opts.branch !== undefined ? slugify(opts.branch.replace(/^glade\//, "")) : slugify(opts.name)) || slugify(opts.fallback) || "chat";
  const parent = join(opts.worktreesDir, slugify(basename(info.root)) || "repo");
  mkdirSync(parent, { recursive: true });

  let branch = "";
  let path = "";
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    branch = opts.branch ?? `${BRANCH_PREFIX}${slug}${suffix}`;
    path = join(parent, `${slug}${suffix}`);
    if (existsSync(path)) continue;
    if (opts.branch === undefined && (await isLocalBranch(info.root, branch))) continue;
    break;
  }
  try {
    await git(info.root, ["worktree", "add", "-b", branch, path, opts.baseRef !== undefined ? `refs/heads/${baseRef}` : baseRef]);
  } catch (err) {
    throw new HttpError(500, `Could not create a worktree: ${(err as Error).message}`);
  }
  const realPath = realpathSync(path);
  if (opts.carryChanges) {
    try {
      await carryUncommittedChanges(info.root, realPath);
    } catch (err) {
      await git(info.root, ["worktree", "remove", "--force", realPath]).catch(() => {});
      await git(info.root, ["branch", "-D", branch]).catch(() => {});
      throw new HttpError(500, `Couldn't bring your uncommitted changes into the worktree, so it wasn't created: ${(err as Error).message}`);
    }
  }
  const sub = relative(info.root, realpathSync(opts.folder));
  const cwd = sub ? join(realPath, sub) : realPath;
  mkdirSync(cwd, { recursive: true }); // an untracked subfolder isn't checked out
  return { worktree: { path: realPath, branch, baseRef, repoRoot: info.root }, cwd };
}

/**
 * Copy the uncommitted changes of the repository at `root` into the worktree at `target`, which
 * must be checked out at the same commit; `root` is left as it is.
 *
 * Tracked changes: `git stash create` writes the working tree and index as a stash commit without
 * touching the folder, the index or the stash list, and `git stash apply --index <sha>` in the
 * worktree (same object database) replays it, staged vs unstaged included. Unlike piping
 * `git diff --binary HEAD` into `git apply`, it works on git objects, so binary files, renames,
 * deletions and mode changes carry over exactly and user diff settings (noprefix, textconv,
 * external diff, colour) can't break it. Untracked, non-ignored files (`ls-files --others
 * --exclude-standard`) are copied, paths and modes preserved, symlinks as symlinks; nested
 * repositories (listed as `dir/`) are skipped.
 */
export async function carryUncommittedChanges(root: string, target: string): Promise<void> {
  const stash = (await git(root, ["stash", "create", "Glade: carry uncommitted changes"])).trim();
  if (stash) await git(target, ["stash", "apply", "--index", "--quiet", stash]);
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter((p) => p && !p.endsWith("/"));
  for (const path of untracked) {
    const to = join(target, path);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(root, path), to, { verbatimSymlinks: true, errorOnExist: true, force: false });
  }
}

/** Why the branch can't be merged into its base in the project folder right now; null = it can. */
async function mergeBlocker(wt: WorkspaceWorktree): Promise<string | null> {
  if (!existsSync(wt.repoRoot)) return `The project folder ${wt.repoRoot} is missing`;
  if (!(await ok(git(wt.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${wt.baseRef}`])))) {
    return `${wt.baseRef} isn't a branch, so there's nothing to merge into`;
  }
  const current = (await git(wt.repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
  if (current !== wt.baseRef) return `The project folder is on ${current || "a detached HEAD"}, not ${wt.baseRef}; switch it to ${wt.baseRef} to merge`;
  const dirty = (await git(wt.repoRoot, ["status", "--porcelain", "--untracked-files=no"])).trim();
  if (dirty) return `The project folder has uncommitted changes; commit or stash them to merge into ${wt.baseRef}`;
  return null;
}

export async function worktreeStatus(wt: WorkspaceWorktree): Promise<WorktreeStatus> {
  const exists = existsSync(wt.path);
  const uncommittedFiles = exists
    ? (await git(wt.path, ["status", "--porcelain"]).catch(() => "")).split("\n").filter((l) => l.trim()).length
    : 0;
  const ahead = Number((await git(wt.repoRoot, ["rev-list", "--count", `${wt.baseRef}..${wt.branch}`]).catch(() => "0")).trim()) || 0;
  return { branch: wt.branch, baseRef: wt.baseRef, exists, uncommittedFiles, ahead, mergeBlocker: await mergeBlocker(wt) };
}

/**
 * `git merge` the worktree's branch into its base branch in the project folder. 409 (and nothing
 * changed) when the folder isn't clean / on the base branch, or when the merge conflicts.
 */
export async function mergeWorktree(wt: WorkspaceWorktree): Promise<void> {
  const blocker = await mergeBlocker(wt);
  if (blocker) throw new HttpError(409, blocker);
  try {
    await git(wt.repoRoot, ["merge", "--no-edit", wt.branch]);
  } catch (err) {
    await git(wt.repoRoot, ["merge", "--abort"]).catch(() => {});
    throw new HttpError(409, `Merging ${wt.branch} into ${wt.baseRef} failed, nothing was deleted: ${(err as Error).message}`);
  }
}

/**
 * Remove the worktree folder (even with uncommitted changes) and, unless `keep`, its branch
 * (`merge`: only if merged, `git branch -d`; `discard`: `git branch -D`). Call `mergeWorktree` first for `merge`.
 */
export async function removeWorktree(wt: WorkspaceWorktree, removal: WorktreeRemoval): Promise<void> {
  if (existsSync(wt.path)) await git(wt.repoRoot, ["worktree", "remove", "--force", wt.path]);
  else await git(wt.repoRoot, ["worktree", "prune"]).catch(() => {});
  if (removal !== "keep") await git(wt.repoRoot, ["branch", removal === "merge" ? "-d" : "-D", wt.branch]);
}
