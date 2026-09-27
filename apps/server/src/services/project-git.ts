/**
 * Git in a project's own folder (I-105): its branches and uncommitted files for the new-chat
 * context bar, switching branches (refused while the folder has uncommitted changes) and creating
 * one. Also the small `git` helpers `worktrees.ts` builds on. Everything runs `git` via
 * `execFile` (no shell); branch names are checked with `git check-ref-format --branch`.
 *
 * Callers (`app/projects.ts`) additionally refuse to switch while a chat of the project is working
 * in the folder; this module only knows about git.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { PROJECT_BRANCHES_MAX, UNCOMMITTED_PATHS_MAX, type ProjectBranch, type ProjectGitInfo } from "@glade/protocol";
import { HttpError } from "./app/errors.js";

/** A git failure: the command's stderr (or message). */
export class GitError extends Error {}

/** git's environment without variables that would point it at another repository. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"]) delete env[key];
  return env;
}

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env: gitEnv(), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new GitError(String(stderr).trim() || err.message));
      else resolve(String(stdout));
    });
  });
}

export const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

export interface RepoInfo {
  /** The repository's main work tree (realpath). */
  root: string;
  /** Current branch, or null when detached. */
  branch: string | null;
  /** HEAD resolves to a commit. */
  hasCommits: boolean;
}

export async function repoInfo(folder: string): Promise<RepoInfo | null> {
  if (!existsSync(folder)) return null;
  let root: string;
  try {
    root = (await git(folder, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  if (!root) return null;
  const branch = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim() || null;
  const hasCommits = await ok(git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]));
  return { root: realpathSync(root), branch, hasCommits };
}

export const isLocalBranch = (root: string, name: string) => ok(git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]));

/** 400 unless `name` is a valid new branch name (`git check-ref-format --branch`, no leading dash). */
export async function assertBranchName(root: string, name: string): Promise<void> {
  const valid = name.trim() === name && name !== "" && !name.startsWith("-") && name !== "HEAD" && (await ok(git(root, ["check-ref-format", "--branch", name])));
  if (!valid) throw new HttpError(400, `"${name}" isn't a valid branch name`);
}

/** The repository's default branch: `origin/HEAD` when it names a local branch, else `main`/`master`. */
async function defaultBranch(root: string, local: Set<string>): Promise<string | null> {
  const remote = (await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")).trim();
  const fromRemote = remote.replace(/^origin\//, "");
  if (fromRemote && local.has(fromRemote)) return fromRemote;
  return ["main", "master"].find((b) => local.has(b)) ?? null;
}

/** Local branches: current, default, then newest commit first; capped. */
async function listBranches(root: string, current: string | null): Promise<ProjectBranch[]> {
  const out = await git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%00%(committerdate:unix)", "refs/heads"]).catch(() => "");
  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", date = "0"] = line.split("\0");
      return { name, committedAt: Number(date) * 1000 || 0 };
    })
    .filter((r) => r.name);
  const def = await defaultBranch(root, new Set(rows.map((r) => r.name)));
  const rank = (name: string) => (name === current ? 0 : name === def ? 1 : 2);
  return rows
    .map((r) => ({ ...r, current: r.name === current, isDefault: r.name === def }))
    .sort((a, b) => rank(a.name) - rank(b.name)) // stable: keeps the date order within a rank
    .slice(0, PROJECT_BRANCHES_MAX);
}

/** Repo-relative paths `git status` reports (tracked changes and untracked files). */
export async function uncommittedPaths(root: string): Promise<string[]> {
  const out = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths: string[] = [];
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // the rename's source path follows
  }
  return paths;
}

/** Whether a project folder is a git repository, its branches and uncommitted files (`GET /projects/:id/git`). */
export async function projectGitInfo(folder: string): Promise<ProjectGitInfo> {
  const info = await repoInfo(folder);
  if (!info?.hasCommits) return { isRepo: false, branch: info?.branch ?? null, branches: [], uncommittedFiles: 0, uncommittedPaths: [] };
  const [branches, paths] = await Promise.all([listBranches(info.root, info.branch), uncommittedPaths(info.root).catch(() => [])]);
  return {
    isRepo: true,
    branch: info.branch,
    branches,
    uncommittedFiles: paths.length,
    uncommittedPaths: paths.slice(0, UNCOMMITTED_PATHS_MAX),
  };
}

async function requireRepo(folder: string): Promise<RepoInfo> {
  const info = await repoInfo(folder);
  if (!info?.hasCommits) throw new HttpError(400, `${folder} isn't a git repository with commits`);
  return info;
}

/** "3 uncommitted files (a.txt, b.txt, c.txt)" */
function describeDirty(paths: string[]): string {
  const shown = paths.slice(0, 5).join(", ");
  const more = paths.length > 5 ? `, and ${paths.length - 5} more` : "";
  return `${paths.length} uncommitted ${paths.length === 1 ? "file" : "files"} (${shown}${more})`;
}

/**
 * Check out a local branch in the project folder. 400 when it isn't a local branch, 409 when the
 * folder has uncommitted changes (commit first) or git refuses (e.g. it's checked out in a worktree).
 */
export async function checkoutBranch(folder: string, branch: string): Promise<ProjectGitInfo> {
  const info = await requireRepo(folder);
  if (branch.startsWith("-") || !(await isLocalBranch(info.root, branch))) throw new HttpError(400, `${branch} isn't a local branch`);
  if (info.branch === branch) return projectGitInfo(folder);
  const dirty = await uncommittedPaths(info.root);
  if (dirty.length) throw new HttpError(409, `The project folder has ${describeDirty(dirty)}; commit them to switch to ${branch}`);
  try {
    await git(info.root, ["checkout", "-q", branch, "--"]);
  } catch (err) {
    throw new HttpError(409, `Couldn't switch to ${branch}: ${(err as Error).message}`);
  }
  return projectGitInfo(folder);
}

/**
 * Create a branch from the current HEAD; with `checkout`, switch to it (git keeps uncommitted
 * changes, nothing in the folder changes). 400 invalid name, 409 when it already exists.
 */
export async function createBranch(folder: string, name: string, checkout: boolean): Promise<ProjectGitInfo> {
  const info = await requireRepo(folder);
  await assertBranchName(info.root, name);
  if (await isLocalBranch(info.root, name)) throw new HttpError(409, `A branch named ${name} already exists`);
  try {
    await git(info.root, checkout ? ["checkout", "-q", "-b", name] : ["branch", name]);
  } catch (err) {
    throw new HttpError(409, `Couldn't create ${name}: ${(err as Error).message}`);
  }
  return projectGitInfo(folder);
}
