/**
 * Git changes of a folder (I-097, the changes panel): what git sees, whoever changed it.
 *
 *   const git = new GitChangesService({ complete: (prompt, cwd) => app.completeQuick(prompt, cwd) });
 *   await git.status(cwd);                 // changed files with +/− counts (vs HEAD)
 *   await git.diff(cwd, "src/a.ts");        // DiffLine[] (untracked files via `--no-index`)
 *   await git.revert(cwd, ["src/a.ts"]);    // restore from HEAD / delete untracked
 *   await git.commit(cwd, "Fix it", paths); // commit all or some changed files
 *   await git.commitMessage(cwd, paths);    // a message from the small model
 *
 * Runs `git` with `spawn` (no shell) at the repository root, with literal pathspecs and bounded
 * output. The workspace folder may be a subfolder of the repository: only changes under it are
 * listed. Paths from clients must be ones `status` reports (so nothing outside the folder, and
 * nothing unchanged, can be reverted or committed).
 */
import { spawn } from "node:child_process";
import { open, rm } from "node:fs/promises";
import { isAbsolute, join, posix } from "node:path";
import type {
  CommitChangesResponse,
  CommitMessageResponse,
  DiffLine,
  GitChangedFile,
  GitChangeKind,
  GitChangesResponse,
  GitFileDiffResponse,
} from "@glade/protocol";
import { HttpError } from "./app/errors.js";

/** The empty tree: the base of a repository without commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_FILES = 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_LINES = 4000;
/** Untracked files larger than this get no line counts. */
const MAX_COUNT_BYTES = 1024 * 1024;
const MAX_PROMPT_DIFF_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export type QuickComplete = (prompt: string, cwd: string) => Promise<string | null>;

export interface GitChangesOptions {
  /** One-shot small-model completion for commit messages; without it `commitMessage` is a 501. */
  complete?: QuickComplete;
  timeoutMs?: number;
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout was cut at the byte limit. */
  truncated: boolean;
}

interface Repo {
  root: string;
  prefix: string;
}

interface Status {
  repo: Repo;
  branch: string | null;
  head?: string;
  files: GitChangedFile[];
  truncated: boolean;
}

export class GitChangesService {
  constructor(private readonly options: GitChangesOptions = {}) {}

  async status(cwd: string): Promise<GitChangesResponse> {
    const repo = await this.repo(cwd);
    if (!repo) return { isRepo: false };
    const status = await this.readStatus(repo);
    return { isRepo: true, branch: status.branch, ...(status.head && { head: status.head }), root: repo.root, prefix: repo.prefix, files: status.files, truncated: status.truncated };
  }

  async diff(cwd: string, path: string): Promise<GitFileDiffResponse> {
    const status = await this.requireStatus(cwd);
    const file = requireChanged(status, [path])[0]!;
    const { root } = status.repo;
    let result: GitResult;
    if (file.kind === "untracked") {
      result = await this.git(root, ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", file.path], { okCodes: [0, 1] });
    } else {
      const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
      result = await this.git(root, ["diff", await this.base(root), "-M", "--no-color", "--no-ext-diff", "--", ...paths]);
    }
    return { path: file.path, ...parseUnifiedDiff(result.stdout, result.truncated) };
  }

  async revert(cwd: string, paths: string[]): Promise<GitChangesResponse> {
    const status = await this.requireStatus(cwd);
    const files = requireChanged(status, paths);
    const { root } = status.repo;
    for (const file of files) {
      switch (file.kind) {
        case "untracked":
          await rm(join(root, file.path), { force: true });
          break;
        case "added":
          await this.git(root, ["rm", "-f", "-q", "--", file.path]);
          break;
        case "renamed":
          await this.git(root, ["rm", "-f", "-q", "--", file.path]);
          if (file.oldPath) await this.git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", file.oldPath]);
          break;
        default:
          await this.git(root, ["restore", "--source=HEAD", "--staged", "--worktree", "--", file.path]);
      }
    }
    return this.status(cwd);
  }

  async commit(cwd: string, message: string, paths?: string[]): Promise<CommitChangesResponse> {
    const text = message.trim();
    if (!text) throw new HttpError(400, "message is required");
    const status = await this.requireStatus(cwd);
    const files = paths ? requireChanged(status, paths) : status.files;
    if (files.length === 0) throw new HttpError(409, "Nothing to commit");
    const { root } = status.repo;
    const pathspec = files.flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
    const input = pathspec.join("\0");
    // Stage first (`add` fails on a path that's gone from both the work tree and the index).
    const gone = files.flatMap((f) => (f.kind === "deleted" ? [f.path] : f.oldPath ? [f.oldPath] : []));
    const present = files.filter((f) => f.kind !== "deleted").map((f) => f.path);
    if (gone.length) {
      await this.git(root, ["rm", "--cached", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: gone.join("\0") });
    }
    if (present.length) await this.git(root, ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], { input: present.join("\0") });
    // `--only` (the default with paths): other staged changes stay staged and out of this commit.
    await this.git(root, ["commit", "-q", "-m", text, "--pathspec-from-file=-", "--pathspec-file-nul"], { input, timeoutMs: 120_000 });
    const hash = await this.git(root, ["rev-parse", "--short", "HEAD"]);
    return { commit: hash.stdout.trim(), summary: text.split("\n")[0]!.trim() };
  }

  async commitMessage(cwd: string, paths?: string[]): Promise<CommitMessageResponse> {
    const complete = this.options.complete;
    if (!complete) throw new HttpError(501, "No model is available to write a commit message");
    const status = await this.requireStatus(cwd);
    const files = paths ? requireChanged(status, paths) : status.files;
    if (files.length === 0) throw new HttpError(409, "Nothing to commit");
    const { root } = status.repo;
    const tracked = files.filter((f) => f.kind !== "untracked").flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
    let diff = "";
    if (tracked.length) {
      const base = await this.base(root);
      const stat = await this.git(root, ["diff", base, "-M", "--stat", "--no-color", "--", ...tracked]);
      const patch = await this.git(root, ["diff", base, "-M", "-U2", "--no-color", "--no-ext-diff", "--", ...tracked]);
      diff = `${stat.stdout}\n${patch.stdout}`;
    }
    for (const file of files.filter((f) => f.kind === "untracked")) {
      if (diff.length > MAX_PROMPT_DIFF_CHARS) break;
      diff += `\nNew file ${file.path}${file.binary ? " (binary)" : `:\n${await readHead(join(root, file.path), 1500)}`}\n`;
    }
    const reply = await complete(commitMessagePrompt(files, diff.slice(0, MAX_PROMPT_DIFF_CHARS)), root);
    const message = cleanCommitMessage(reply ?? "");
    if (!message) throw new HttpError(500, "The model didn't come up with a commit message");
    return { message };
  }

  // -------------------------------------------------------------------------------------------

  /** The repository around `cwd`, or `null` when it isn't in one (or doesn't exist). */
  private async repo(cwd: string): Promise<Repo | null> {
    const result = await this.run(cwd, ["rev-parse", "--show-toplevel", "--show-prefix"]).catch(() => null);
    if (!result || result.code !== 0) return null;
    const [root, prefix = ""] = result.stdout.split("\n");
    return root ? { root, prefix: prefix.trim() } : null;
  }

  private async requireStatus(cwd: string): Promise<Status> {
    const repo = await this.repo(cwd);
    if (!repo) throw new HttpError(409, "This folder isn't a git repository");
    return this.readStatus(repo);
  }

  private async readStatus(repo: Repo): Promise<Status> {
    const scope = repo.prefix ? ["--", repo.prefix] : [];
    const status = await this.git(repo.root, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", ...scope]);
    const parsed = parseStatus(status.stdout);
    const files = parsed.files.slice(0, MAX_FILES);
    const numstat = await this.git(repo.root, ["diff", await this.base(repo.root), "-M", "--numstat", "-z", ...scope]);
    const counts = parseNumstat(numstat.stdout);
    for (const file of files) {
      if (file.kind === "untracked") Object.assign(file, await countFile(join(repo.root, file.path)));
      else {
        const c = counts.get(file.path);
        if (c) Object.assign(file, c);
      }
    }
    return { repo, branch: parsed.branch, head: parsed.head, files, truncated: status.truncated || parsed.files.length > MAX_FILES };
  }

  /** `HEAD`, or the empty tree before the first commit. */
  private async base(root: string): Promise<string> {
    const head = await this.run(root, ["rev-parse", "--verify", "-q", "HEAD"]);
    return head.code === 0 ? "HEAD" : EMPTY_TREE;
  }

  /** Run git; a non-zero exit (outside `okCodes`) is a 409 with git's message. */
  private async git(cwd: string, args: string[], opts: { input?: string; okCodes?: number[]; timeoutMs?: number } = {}): Promise<GitResult> {
    const result = await this.run(cwd, args, opts);
    if (!(opts.okCodes ?? [0]).includes(result.code ?? -1)) {
      const message = (result.stderr || result.stdout).trim().split("\n").slice(0, 6).join("\n");
      throw new HttpError(409, message || `git ${args[0]} failed`);
    }
    return result;
  }

  private run(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", ["-c", "core.quotepath=off", "-c", "color.ui=false", ...args], {
        cwd,
        env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        if (truncated) return;
        if (bytes + chunk.length > MAX_OUTPUT_BYTES) {
          out.push(chunk.subarray(0, MAX_OUTPUT_BYTES - bytes));
          truncated = true;
          child.kill("SIGKILL");
          return;
        }
        bytes += chunk.length;
        out.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          code: truncated ? 0 : code,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8").slice(0, 4000),
          truncated,
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(opts.input ?? "");
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing (exported for tests)
// ---------------------------------------------------------------------------------------------

/** `git status --porcelain=v2 -z --branch` → branch, short `HEAD` hash (absent before the first commit) + files. */
export function parseStatus(stdout: string): { branch: string | null; head?: string; files: GitChangedFile[] } {
  const fields = stdout.split("\0");
  const files: GitChangedFile[] = [];
  let branch: string | null = null;
  let head: string | undefined;
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (!entry) continue;
    const type = entry[0];
    if (type === "#") {
      const m = /^# branch\.head (.+)$/.exec(entry);
      if (m) branch = m[1] === "(detached)" ? null : m[1]!;
      const oid = /^# branch\.oid ([0-9a-f]+)$/.exec(entry);
      if (oid) head = oid[1]!.slice(0, 7);
    } else if (type === "?") {
      files.push(changed(entry.slice(2), "untracked"));
    } else if (type === "1") {
      const parts = entry.split(" ");
      const xy = parts[1] ?? "..";
      files.push(changed(parts.slice(8).join(" "), ordinaryKind(xy)));
    } else if (type === "2") {
      const parts = entry.split(" ");
      const file = changed(parts.slice(9).join(" "), "renamed");
      file.oldPath = fields[++i];
      if ((parts[8] ?? "").startsWith("C")) {
        // A copy: the original is unchanged, so this is just a new file.
        file.kind = "added";
        delete file.oldPath;
      }
      files.push(file);
    } else if (type === "u") {
      files.push(changed(entry.split(" ").slice(10).join(" "), "conflicted"));
    }
  }
  return { branch, ...(head && { head }), files };
}

function ordinaryKind(xy: string): GitChangeKind {
  const [x, y] = xy;
  if (x === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

function changed(path: string, kind: GitChangeKind): GitChangedFile {
  return { path, kind, added: null, removed: null, binary: false };
}

type Counts = Pick<GitChangedFile, "added" | "removed" | "binary">;

/** `git diff --numstat -z` (with renames) → counts by (new) path. */
export function parseNumstat(stdout: string): Map<string, Counts> {
  const counts = new Map<string, Counts>();
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[i]!);
    if (!m) continue;
    let path = m[3]!;
    // A rename: "a\tr\t" then the old and the new path as separate fields.
    if (!path) {
      i++;
      path = fields[++i] ?? "";
    }
    const binary = m[1] === "-";
    counts.set(path, { binary, added: binary ? null : Number(m[1]), removed: binary ? null : Number(m[2]) });
  }
  return counts;
}

/** A unified diff (one file) → DiffLine[] with gaps between hunks. */
export function parseUnifiedDiff(stdout: string, truncated = false): { binary: boolean; lines: DiffLine[]; truncated: boolean } {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let binary = false;
  for (const raw of stdout.split("\n")) {
    if (lines.length >= MAX_DIFF_LINES) return { binary, lines, truncated: true };
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      if (lines.length > 0 || oldLine > 1 || newLine > 1) lines.push({ type: "gap", text: "" });
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith("Binary files ") || raw === "GIT binary patch") binary = true;
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
    } else if (raw.startsWith("+")) {
      lines.push({ type: "add", text: raw.slice(1), newLine: newLine++ });
    } else if (raw.startsWith("-")) {
      lines.push({ type: "del", text: raw.slice(1), oldLine: oldLine++ });
    } else if (raw.startsWith(" ")) {
      lines.push({ type: "context", text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return { binary, lines, truncated };
}

/**
 * The files a request names, each one `status` reports; 400 for paths that could leave the folder,
 * 404 for paths without changes.
 */
function requireChanged(status: Status, paths: unknown): GitChangedFile[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new HttpError(400, "paths must be a non-empty array of strings");
  const byPath = new Map(status.files.map((f) => [f.path, f]));
  const out: GitChangedFile[] = [];
  for (const path of paths) {
    if (!isSafeRelativePath(path)) throw new HttpError(400, `Invalid path: ${String(path)}`);
    const file = byPath.get(path);
    if (!file) throw new HttpError(404, `No changes in ${path}`);
    if (!out.includes(file)) out.push(file);
  }
  return out;
}

export function isSafeRelativePath(path: unknown): path is string {
  if (typeof path !== "string" || !path || path.includes("\0") || isAbsolute(path) || path.includes("\\")) return false;
  const normal = posix.normalize(path);
  return normal === path && normal !== "." && normal !== ".." && !normal.startsWith("../");
}

/** Line counts of an untracked file (binary = a NUL byte in the first 8 KB). */
async function countFile(path: string): Promise<Counts> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return { added: null, removed: null, binary: false };
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, 8192));
    await handle.read(head, 0, head.length, 0);
    if (head.includes(0)) return { added: null, removed: 0, binary: true };
    if (size > MAX_COUNT_BYTES) return { added: null, removed: 0, binary: false };
    const text = (await handle.readFile()).toString("utf8");
    const newlines = text.split("\n").length - 1;
    return { added: newlines + (text && !text.endsWith("\n") ? 1 : 0), removed: 0, binary: false };
  } finally {
    await handle.close();
  }
}

async function readHead(path: string, maxChars: number): Promise<string> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return "";
  try {
    const buf = Buffer.alloc(maxChars);
    const { bytesRead } = await handle.read(buf, 0, maxChars, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function commitMessagePrompt(files: GitChangedFile[], diff: string): string {
  const list = files.map((f) => `${f.kind} ${f.oldPath ? `${f.oldPath} → ` : ""}${f.path}`).join("\n");
  return [
    "Write a git commit message for the changes below.",
    "Format: a summary line in the imperative mood, at most 72 characters, no trailing period;",
    "then, only if the change needs explaining, a blank line and a short body wrapped at 72 characters.",
    "Reply with the commit message only: no quotes, no code fences, no preamble.",
    "",
    "Changed files:",
    list,
    "",
    "Diff:",
    diff,
  ].join("\n");
}

/** Strip code fences / quotes / "Commit message:" preambles a model may add. */
export function cleanCommitMessage(reply: string): string {
  let text = reply.trim();
  const fence = /^```[\w-]*\n([\s\S]*?)\n```$/.exec(text);
  if (fence) text = fence[1]!.trim();
  text = text.replace(/^(commit message|message):\s*/i, "").trim();
  if (/^["'`].*["'`]$/s.test(text) && !text.includes("\n")) text = text.slice(1, -1).trim();
  return text;
}
