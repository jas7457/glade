/**
 * Update Now (I-154): pull, install and rebuild the Mac app from its repo folder, as a background
 * job of the desktop app's server. The shell relaunches the new bundle afterwards (the web asks it).
 *
 * - Only the Mac app's server runs it (`available`); `pnpm dev` just shows the command.
 * - Guards first (nothing is changed when one says no): the build's repo folder exists, has no
 *   uncommitted changes, is on main, and can fast-forward to origin's main (`git fetch`, then
 *   `merge-base --is-ancestor`).
 * - Then {@link UPDATE_STEPS} in the repo folder, each through the user's login shell
 *   (`$SHELL -lc`, with `~/.cargo/env` sourced when present) so node/pnpm/cargo resolve like in a
 *   terminal. Output goes to a ring buffer of the last {@link LOG_LINES} lines.
 * - One job at a time. Cancel works while checking and before the install step
 *   (`pnpm tauri:install` swaps the bundle in; it isn't interrupted).
 * - Every change is reported through `onChange` (the server pushes it as `update`, throttled).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UPDATE_BRANCH, UPDATE_STEPS, type BuildInfo, type UpdateJobState, type UpdateJobStatus, type UpdateStep, type UpdateStepId } from "@glade/protocol";
import { runGit, type GitRun } from "./update-check.js";

export const LOG_LINES = 400;

/** Why a server other than the Mac app's doesn't offer Update Now. */
export const UPDATE_UNAVAILABLE_DEV = "Only the Glade app updates itself. This is a development server: run the command in the repo folder.";
const MAX_LINE = 2000;
const FETCH_TIMEOUT_MS = 60_000;
const LOCAL_TIMEOUT_MS = 10_000;

/** Runs a shell command in `cwd`; streams output; resolves the exit code (null: killed). */
export type ShellRun = (command: string, cwd: string, onOutput: (chunk: string) => void, signal: AbortSignal) => Promise<number | null>;

/** Server config and agent identity that the build commands must not inherit (see harness/pi/child-env.ts). */
const STRIPPED = ["URL", "SESSION_ID", "TOKEN", "AGENT_NAME", "PORT", "HOST", "STATIC_DIR", "EXIT_ON_STDIN_CLOSE", "SERVER_KIND", "TOOLS", "SUBAGENTS"].flatMap((n) => [`GLADE_${n}`, `PI_UI_${n}`]);

/** The environment for the update commands: ours without the server's own config. */
export function updateEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!STRIPPED.includes(key)) out[key] = value;
  // No prompts: git never asks; pnpm doesn't ask before purging node_modules (no TTY here).
  out.GIT_TERMINAL_PROMPT = "0";
  out.npm_config_confirm_modules_purge = "false";
  return out;
}

/** The script a step runs in the login shell: cargo's env first (rustup installs it there), then the command. */
export function stepScript(command: string): string {
  return `if [ -f "$HOME/.cargo/env" ]; then . "$HOME/.cargo/env"; fi\n${command}`;
}

/** `$SHELL -lc <script>` in `cwd`, in its own process group (Cancel stops the whole tree). */
export const runInLoginShell: ShellRun = (command, cwd, onOutput, signal) =>
  new Promise((resolve, reject) => {
    const shell = process.env.SHELL || "/bin/zsh";
    const child = spawn(shell, ["-lc", stepScript(command)], { cwd, env: updateEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    if (signal.aborted) kill();
    signal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (d: Buffer) => onOutput(d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => onOutput(d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      signal.removeEventListener("abort", kill);
      resolve(signal.aborted ? null : code);
    });
  });

export interface UpdateJobOptions {
  /** This server's build (its `repoPath` is the folder to update). */
  build: () => BuildInfo | null;
  /** Null: this server can run updates; else why not (e.g. `pnpm dev`). */
  unavailableReason: string | null;
  git?: GitRun;
  shell?: ShellRun;
  exists?: (path: string) => boolean;
  now?: () => Date;
}

class Refused extends Error {}

export class UpdateJob {
  private readonly git: GitRun;
  private readonly shell: ShellRun;
  private readonly exists: (path: string) => boolean;
  private readonly now: () => Date;
  private state: UpdateJobState = "idle";
  private steps: UpdateStep[] = freshSteps();
  private error: string | undefined;
  private log: string[] = [];
  /** An unfinished last line of output. */
  private partial = "";
  private startedAt: string | undefined;
  private endedAt: string | undefined;
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;
  private readonly listeners = new Set<(status: UpdateJobStatus) => void>();

  constructor(private readonly options: UpdateJobOptions) {
    this.git = options.git ?? runGit;
    this.shell = options.shell ?? runInLoginShell;
    this.exists = options.exists ?? existsSync;
    this.now = options.now ?? (() => new Date());
  }

  status(): UpdateJobStatus {
    const reason = this.options.unavailableReason;
    const log = this.partial ? [...this.log, this.partial] : [...this.log];
    return {
      available: reason === null,
      ...(reason !== null ? { unavailableReason: reason } : {}),
      state: this.state,
      steps: this.steps.map((s) => ({ ...s })),
      ...(this.error ? { error: this.error } : {}),
      log: log.slice(-LOG_LINES),
      canCancel: this.canCancel(),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
    };
  }

  onChange(listener: (status: UpdateJobStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The job in progress (tests), or null. */
  get done(): Promise<void> | null {
    return this.running;
  }

  /** Checking or running a step (I-197: the restart waits until the job is done). */
  busy(): boolean {
    return this.state === "checking" || this.state === "running";
  }

  private canCancel(): boolean {
    if (this.state === "checking") return true;
    if (this.state !== "running") return false;
    return !this.steps.some((s) => s.id === "build" && s.state === "running");
  }

  /** Starts an update. Throws (with a sentence) when it can't start at all. */
  start(): UpdateJobStatus {
    if (this.options.unavailableReason !== null) throw new Error(this.options.unavailableReason);
    if (this.busy()) throw new Error("An update is already running.");
    if (this.state === "installed") throw new Error("The update is installed: restart Glade to use it.");
    this.state = "checking";
    this.steps = freshSteps();
    this.error = undefined;
    this.log = [];
    this.partial = "";
    this.startedAt = this.now().toISOString();
    this.endedAt = undefined;
    const abort = new AbortController();
    this.abort = abort;
    this.running = this.run(abort.signal).finally(() => {
      this.running = null;
      this.abort = null;
    });
    this.emit();
    return this.status();
  }

  /** Cancel (while checking or before the install step). Throws when it's too late or nothing runs. */
  cancel(): UpdateJobStatus {
    if (!this.busy()) throw new Error("No update is running.");
    if (!this.canCancel()) throw new Error("The new version is being built and installed; it can't be cancelled now.");
    this.abort?.abort();
    return this.status();
  }

  dispose(): void {
    if (this.canCancel()) this.abort?.abort();
    this.listeners.clear();
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) listener(status);
  }

  private append(chunk: string): void {
    const parts = (this.partial + chunk.replace(/\r\n/g, "\n")).split("\n");
    this.partial = (parts.pop() ?? "").slice(-MAX_LINE);
    for (const line of parts) {
      // Progress bars redraw with \r: keep what's shown last.
      const shown = line.split("\r").filter(Boolean).pop() ?? "";
      this.log.push(shown.slice(0, MAX_LINE));
    }
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES);
    this.emit();
  }

  private note(line: string): void {
    this.append(`${this.partial ? "\n" : ""}${line}\n`);
  }

  private finish(state: UpdateJobState, error?: string): void {
    if (this.partial) {
      this.log.push(this.partial);
      this.partial = "";
    }
    this.state = state;
    this.error = error;
    this.endedAt = this.now().toISOString();
    this.emit();
  }

  private async run(signal: AbortSignal): Promise<void> {
    let repo: string;
    try {
      repo = await this.guards(signal);
    } catch (err) {
      if (signal.aborted) return this.finish("cancelled");
      const message = (err as Error).message;
      return err instanceof Refused ? this.finish("refused", message) : this.finish("failed", message);
    }
    if (signal.aborted) return this.finish("cancelled");
    this.state = "running";
    for (const step of this.steps) {
      if (signal.aborted) break;
      step.state = "running";
      this.note(`$ ${step.command}`);
      let code: number | null;
      try {
        code = await this.shell(step.command, repo, (chunk) => this.append(chunk), signal);
      } catch (err) {
        step.state = "failed";
        return this.finish("failed", `${step.label} couldn't start: ${(err as Error).message}`);
      }
      if (signal.aborted || code === null) {
        step.state = "cancelled";
        break;
      }
      if (code !== 0) {
        step.state = "failed";
        return this.finish("failed", `${step.label} failed (\`${step.command}\` exited with ${code}).`);
      }
      step.state = "done";
      this.emit();
    }
    if (signal.aborted) {
      for (const s of this.steps) if (s.state === "pending" || s.state === "running") s.state = "cancelled";
      return this.finish("cancelled");
    }
    this.finish("installed");
  }

  /** The repo folder, once every guard passed; throws `Refused` with the reason otherwise. */
  private async guards(signal: AbortSignal): Promise<string> {
    const build = this.options.build();
    const repo = build?.repoPath;
    if (!build || !repo) throw new Refused("This build doesn't know which folder it was built from.");
    if (!this.exists(join(repo, ".git"))) throw new Refused(`The folder it was built from (${repo}) isn't on this Mac.`);
    this.note(`Checking ${repo}…`);
    const changed = (await this.git(["status", "--porcelain", "--untracked-files=no"], repo, LOCAL_TIMEOUT_MS)).trim();
    if (changed) {
      const n = changed.split("\n").length;
      throw new Refused(`The repo has uncommitted changes (${n} file${n === 1 ? "" : "s"}). Commit or stash them, then try again.`);
    }
    const branch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"], repo, LOCAL_TIMEOUT_MS)).trim();
    if (branch !== UPDATE_BRANCH) throw new Refused(`The repo is on ${branch === "HEAD" ? "a detached HEAD" : `branch ${branch}`}, not ${UPDATE_BRANCH}. Switch to ${UPDATE_BRANCH}, then try again.`);
    if (signal.aborted) return repo;
    this.note(`$ git fetch origin ${UPDATE_BRANCH}`);
    try {
      await this.git(["fetch", "origin", UPDATE_BRANCH], repo, FETCH_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`Couldn't fetch origin: ${(err as Error).message}`);
    }
    try {
      await this.git(["merge-base", "--is-ancestor", "HEAD", `origin/${UPDATE_BRANCH}`], repo, LOCAL_TIMEOUT_MS);
    } catch {
      throw new Refused(`Local ${UPDATE_BRANCH} has commits origin/${UPDATE_BRANCH} doesn't, so it can't fast-forward. Push or reset them, then try again.`);
    }
    return repo;
  }
}

function freshSteps(): UpdateStep[] {
  return UPDATE_STEPS.map((s) => ({ id: s.id as UpdateStepId, label: s.label, command: s.command, state: "pending" }));
}

/** Pushes status changes at most every `ms` (the log can be chatty), always sending the last one. */
export function throttle(send: (status: UpdateJobStatus) => void, ms = 250): (status: UpdateJobStatus) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: UpdateJobStatus | null = null;
  let last = 0;
  return (status) => {
    pending = status;
    const wait = last + ms - Date.now();
    if (wait <= 0 && !timer) {
      last = Date.now();
      pending = null;
      send(status);
      return;
    }
    timer ??= setTimeout(
      () => {
        timer = null;
        last = Date.now();
        if (pending) send(pending);
        pending = null;
      },
      Math.max(wait, 0),
    );
  };
}
