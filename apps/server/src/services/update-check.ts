/**
 * "Is this Glade behind?" (I-149): compares the build's commit with the repo's `origin/main`.
 *
 * Read-only, with the user's own git setup:
 * - only when the build's repo folder exists on this machine;
 * - `git ls-remote origin refs/heads/main` (no fetch, no pull, nothing written; no prompts:
 *   `GIT_TERMINAL_PROMPT=0`, stdin closed, a timeout);
 * - the commits behind are counted with `git rev-list --count <build>..<remote>` only when the
 *   local repo already has that commit; otherwise it's just "update available".
 *
 * Runs at startup, every few hours and on demand (`POST /api/version/check`). Also compares
 * another device's build with ours for Connections ({@link UpdateChecker.compare}).
 *
 * I-197: the status also says when a newer build was installed into this app's bundle
 * (`installed`, from services/installed-build.ts); {@link UpdateChecker.onChange} fires after
 * every finished check (the server pushes the status as `version`).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_BRANCH, type BuildComparison, type BuildInfo, type UpdateCheck, type VersionStatus } from "@glade/protocol";

/** Runs `git <args>` in `cwd`; resolves stdout, rejects on a non-zero exit or the timeout. */
export type GitRun = (args: string[], cwd: string, timeoutMs: number) => Promise<string>;

export const runGit: GitRun = (args, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_OPTIONAL_LOCKS: "0" },
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr).trim().split("\n").pop() || err.message));
        else resolve(String(stdout));
      },
    );
    child.stdin?.end();
  });

export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const LS_REMOTE_TIMEOUT_MS = 20_000;
const LOCAL_TIMEOUT_MS = 5_000;
const SHA = /^[0-9a-f]{7,40}$/;

export interface UpdateCheckerOptions {
  /** This server's build (services/build-info.ts). */
  build: () => BuildInfo | null;
  /** A different build installed into this app's bundle (I-197), when known. */
  installed?: () => BuildInfo | null;
  git?: GitRun;
  /** Whether a path exists (tests). */
  exists?: (path: string) => boolean;
  /** Between automatic checks (default 4 h). */
  intervalMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

export class UpdateChecker {
  private readonly git: GitRun;
  private readonly exists: (path: string) => boolean;
  private readonly now: () => Date;
  private last: UpdateCheck | null = null;
  private running: Promise<VersionStatus> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly compared = new Map<string, BuildComparison>();
  private readonly listeners = new Set<(status: VersionStatus) => void>();

  constructor(private readonly options: UpdateCheckerOptions) {
    this.git = options.git ?? runGit;
    this.exists = options.exists ?? existsSync;
    this.now = options.now ?? (() => new Date());
  }

  status(): VersionStatus {
    const installed = this.options.installed?.() ?? null;
    return { build: this.options.build(), check: this.last, checking: this.running !== null, ...(installed ? { installed } : {}) };
  }

  /** After every finished check. Returns an unsubscribe function. */
  onChange(listener: (status: VersionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Check now and at every interval (the timer doesn't keep the process alive). */
  start(): void {
    if (this.timer) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), this.options.intervalMs ?? CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  /** Runs a check (joins one in progress) and answers with the new status. */
  check(): Promise<VersionStatus> {
    this.running ??= this.runCheck()
      .then((check) => {
        this.last = check;
      })
      .finally(() => {
        this.running = null;
      })
      .then(() => {
        const status = this.status();
        for (const listener of this.listeners) listener(status);
        return status;
      });
    return this.running;
  }

  /** The repo folder the build came from, when it's on this machine. */
  private repo(build: BuildInfo | null): string | null {
    const path = build?.repoPath;
    return path && this.exists(join(path, ".git")) ? path : null;
  }

  private async runCheck(): Promise<UpdateCheck> {
    const build = this.options.build();
    const done = (check: Omit<UpdateCheck, "checkedAt">): UpdateCheck => ({ ...check, checkedAt: this.now().toISOString() });
    if (!build) return done({ state: "unavailable", reason: "This build doesn't know which commit it came from." });
    const repo = this.repo(build);
    if (!repo) return done({ state: "unavailable", reason: `The folder it was built from${build.repoPath ? ` (${build.repoPath})` : ""} isn't on this machine.` });

    let remote: string;
    try {
      const out = await this.git(["ls-remote", "--exit-code", "origin", `refs/heads/${UPDATE_BRANCH}`], repo, LS_REMOTE_TIMEOUT_MS);
      remote = out.trim().split(/\s+/)[0] ?? "";
      if (!/^[0-9a-f]{40}$/.test(remote)) throw new Error(`origin has no ${UPDATE_BRANCH} branch`);
    } catch (err) {
      this.options.log?.(`update check failed: ${(err as Error).message}`);
      return done({ state: "failed", reason: (err as Error).message || "git ls-remote failed" });
    }
    if (remote === build.commit) return done({ state: "up-to-date", remoteCommit: remote });
    const count = await this.count(repo, build.commit, remote);
    if (count === null) return done({ state: "update-available", remoteCommit: remote });
    // 0: the build already contains origin's main (e.g. built from unpushed local commits).
    return done(count === 0 ? { state: "up-to-date", remoteCommit: remote } : { state: "behind", behind: count, remoteCommit: remote });
  }

  /** Commits in `to` that `from` doesn't have, when the local repo has both; else null. */
  private async count(repo: string, from: string, to: string): Promise<number | null> {
    try {
      await this.git(["cat-file", "-e", `${from}^{commit}`], repo, LOCAL_TIMEOUT_MS);
      await this.git(["cat-file", "-e", `${to}^{commit}`], repo, LOCAL_TIMEOUT_MS);
      const n = Number((await this.git(["rev-list", "--count", `${from}..${to}`], repo, LOCAL_TIMEOUT_MS)).trim());
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  /** Another build's commit compared with ours, counted in our repo when it has both commits. */
  async compare(commit: string): Promise<BuildComparison> {
    const theirs = commit.trim().toLowerCase();
    if (!SHA.test(theirs)) throw new Error("commit must be a git sha");
    const build = this.options.build();
    if (!build) return { commit: theirs, relation: "unknown" };
    if (build.commit.startsWith(theirs) || theirs.startsWith(build.commit)) return { commit: theirs, relation: "same" };
    const key = `${build.commit}:${theirs}`;
    const cached = this.compared.get(key);
    if (cached) return cached;
    const repo = this.repo(build);
    if (!repo) return { commit: theirs, relation: "unknown" };
    const ahead = await this.count(repo, build.commit, theirs);
    const behind = ahead === null ? null : await this.count(repo, theirs, build.commit);
    if (ahead === null || behind === null) return { commit: theirs, relation: "unknown" };
    const result: BuildComparison =
      ahead > 0 && behind > 0
        ? { commit: theirs, relation: "diverged" }
        : ahead > 0
          ? { commit: theirs, relation: "newer", count: ahead }
          : behind > 0
            ? { commit: theirs, relation: "older", count: behind }
            : { commit: theirs, relation: "same" };
    this.compared.set(key, result);
    return result;
  }
}
