/**
 * Agent versions and updates (I-198, `@glade/protocol` `agent-versions.ts`): which version of each
 * built-in agent (pi, Claude Code, Codex) is installed on this Mac, the newest one, and Update.
 *
 *   const av = new AgentVersionsService({ busyChats, onUpdated, onChange });
 *   av.start();                         // first check ~30 s later, then every 24 h
 *   await av.check({ force: true });    // the page's Check Now
 *   av.startUpdate("claude");           // runs `claude update` now, or when its chats finish
 *
 * - Checks run every agent at once (version sources in `versions.ts`); a check that finished less
 *   than `minCheckGapMs` (10 min) ago is reused unless forced; concurrent callers share one.
 * - Update runs `AGENT_UPDATE_COMMANDS[harness]` (or a testing override) through the user's login
 *   shell with stdin closed; output goes to a ring buffer of the last {@link LOG_LINES} lines. One
 *   update at a time per agent. While any chat of that agent works on this server, it waits
 *   (`waiting`, `waitingFor`) and starts when they're all idle (`sessionsChanged()`, plus a slow
 *   tick as a safety net). Cancel works only while waiting.
 * - After a successful run: the installed version is read again (`from` → `to`) and `onUpdated`
 *   reloads the agent's models (the server pushes `models`), then the job is `done`.
 * - Every change calls `onChange` (the server throttles it into `agent_versions` pushes).
 * - A custom command in effect (I-201, `customCommand`) is used for both: `<command> --version`
 *   (via `readInstalled`) and the agent's updater through it (`mywrapper pi update self`).
 */
import { homedir } from "node:os";
import { AGENT_UPDATE_COMMANDS, agentUpdateCommand, formatCommandLine, type AgentCommandLine, type AgentUpdateJob, type AgentVersionInfo, type AgentVersionsStatus, type SessionSummary } from "@glade/protocol";
import { runInLoginShell, type ShellRun } from "../update-job.js";
import {
  AGENT_VERSION_SOURCES,
  compareVersions,
  defaultReadInstalled,
  errorText,
  fetchText as defaultFetchText,
  readClaudeChannel,
  SourceError,
  type FetchText,
  type ReadInstalled,
} from "./versions.js";

export const LOG_LINES = 400;
const MAX_LINE = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A request the API refuses: 404 unknown agent, 409 can't do it now. */
export class AgentVersionsError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentVersionsServiceOptions {
  /** Agents to report (default: every key of `AGENT_UPDATE_COMMANDS`). */
  harnesses?: readonly string[];
  /** Display names for messages ("Claude Code"). Default: the id. */
  label?: (harness: string) => string;
  /** Chats of `harness` working or blocked on this server (see {@link busyChatsOf}). */
  busyChats: (harness: string) => number;
  /** After a successful update: reload that agent's models (and push them). */
  onUpdated?: (harness: string) => Promise<void> | void;
  /** Every change (unthrottled). */
  onChange?: (status: AgentVersionsStatus) => void;
  readInstalled?: ReadInstalled;
  fetchText?: FetchText;
  claudeChannel?: () => "latest" | "stable";
  shell?: ShellRun;
  /** The update command per agent (testing overrides); default `AGENT_UPDATE_COMMANDS`. */
  updateCommands?: Readonly<Record<string, string>>;
  /**
   * The custom command in effect per agent (I-201), read at each use; null = the built-in one.
   * Update runs the agent's updater through it (`agentUpdateCommand`); testing overrides in
   * `updateCommands` still win.
   */
  customCommand?: (harness: string) => AgentCommandLine | null;
  /** Folder the updaters run in. Default: the home folder. */
  cwd?: string;
  startupDelayMs?: number;
  intervalMs?: number;
  minCheckGapMs?: number;
  /** While an update waits, recheck the busy chats this often (a safety net for missed pushes). */
  waitTickMs?: number;
  now?: () => Date;
  log?: (msg: string) => void;
}

interface AgentEntry {
  info: Omit<AgentVersionInfo, "update">;
  job: AgentUpdateJob | null;
  /** An unfinished last line of updater output. */
  partial: string;
  /** Bumped when an update re-reads the installed version (a check started before keeps it). */
  gen: number;
}

/**
 * Chats (workspaces) with a session of `harness` working or blocked on this server (sessions
 * another server runs don't count: updating doesn't stop them).
 */
export function busyChatsOf(sessions: readonly SessionSummary[], harness: string): number {
  const busy = new Set<string>();
  for (const s of sessions) {
    if (s.harness === harness && (s.status === "working" || s.status === "blocked") && !s.activeElsewhere) busy.add(s.workspaceId);
  }
  return busy.size;
}

export class AgentVersionsService {
  private readonly entries = new Map<string, AgentEntry>();
  private readonly readInstalled: ReadInstalled;
  private readonly fetchText: FetchText;
  private readonly shell: ShellRun;
  private readonly now: () => Date;
  private inflight: Promise<AgentVersionsStatus> | null = null;
  private lastCheckEnd: number | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private waitTimer: ReturnType<typeof setInterval> | null = null;
  private readonly runs = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly options: AgentVersionsServiceOptions) {
    this.readInstalled = options.readInstalled ?? defaultReadInstalled({}, options.customCommand);
    this.fetchText = options.fetchText ?? defaultFetchText;
    this.shell = options.shell ?? runInLoginShell;
    this.now = options.now ?? (() => new Date());
    for (const harness of options.harnesses ?? Object.keys(AGENT_UPDATE_COMMANDS)) {
      this.entries.set(harness, {
        info: { harness, installed: null, latest: null, state: "unknown", checkedAt: null, updateCommand: this.commandOf(harness) },
        job: null,
        partial: "",
        gen: 0,
      });
    }
  }

  /** First check after `startupDelayMs` (30 s), then every `intervalMs` (24 h). Doesn't block. */
  start(): void {
    if (this.startTimer || this.interval || this.disposed) return;
    const run = () => void this.check({ force: true }).catch((err: Error) => this.options.log?.(`agent version check failed: ${err.message}`));
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      run();
      this.interval = setInterval(run, this.options.intervalMs ?? DAY_MS);
      this.interval.unref?.();
    }, this.options.startupDelayMs ?? 30_000);
    this.startTimer.unref?.();
  }

  /** Stops the timers. A running updater is left to finish (killing it could break the install). */
  dispose(): void {
    this.disposed = true;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.interval) clearInterval(this.interval);
    this.stopWaitTick();
    this.startTimer = this.interval = null;
  }

  status(): AgentVersionsStatus {
    return {
      agents: [...this.entries.entries()].map(([h, e]) => ({ ...e.info, updateCommand: this.commandOf(h), update: e.job ? this.jobView(e) : null })),
      checking: this.inflight !== null,
    };
  }

  /** Update jobs in progress (tests). */
  get settled(): Promise<void> {
    return Promise.all([...this.runs.values()]).then(() => {});
  }

  /**
   * Check every agent now and answer when done. Without `force`, a check that finished less than
   * `minCheckGapMs` ago is reused. Calls during a check share it.
   */
  check({ force = false }: { force?: boolean } = {}): Promise<AgentVersionsStatus> {
    if (this.inflight) return this.inflight;
    const gap = this.options.minCheckGapMs ?? 10 * 60_000;
    if (!force && this.lastCheckEnd !== null && this.now().getTime() - this.lastCheckEnd < gap) return Promise.resolve(this.status());
    this.inflight = Promise.all([...this.entries.keys()].map((h) => this.checkOne(h))).then(() => {
      this.lastCheckEnd = this.now().getTime();
      this.inflight = null;
      this.emit();
      return this.status();
    });
    this.emit();
    return this.inflight;
  }

  /** Start (or queue) an update of `harness`. Throws {@link AgentVersionsError}. */
  startUpdate(harness: string): AgentVersionsStatus {
    const entry = this.entries.get(harness);
    if (!entry) throw new AgentVersionsError(404, `Glade doesn't know an agent called ${harness}.`);
    const name = this.label(harness);
    const command = this.commandOf(harness);
    if (!command) throw new AgentVersionsError(409, `Glade can't update ${name}.`);
    if (entry.info.state === "not-installed") throw new AgentVersionsError(409, `${name} isn't installed on this Mac.`);
    if (entry.job?.state === "running") throw new AgentVersionsError(409, `${name} is already updating.`);
    if (entry.job?.state === "waiting") throw new AgentVersionsError(409, `An update of ${name} is already waiting for its chats to finish.`);
    const busy = this.options.busyChats(harness);
    entry.partial = "";
    entry.job = { state: "waiting", command, from: entry.info.installed, log: [], requestedAt: this.now().toISOString() };
    if (busy > 0) {
      entry.job.waitingFor = busy;
      this.startWaitTick();
      this.emit();
    } else {
      this.run(harness, entry);
    }
    return this.status();
  }

  /** Cancel an update that's waiting for chats. Throws {@link AgentVersionsError}. */
  cancelUpdate(harness: string): AgentVersionsStatus {
    const entry = this.entries.get(harness);
    if (!entry) throw new AgentVersionsError(404, `Glade doesn't know an agent called ${harness}.`);
    if (entry.job?.state !== "waiting") {
      throw new AgentVersionsError(409, entry.job?.state === "running" ? "The update is already running; it can't be cancelled now." : "No update is waiting.");
    }
    entry.job = { ...entry.job, state: "cancelled", endedAt: this.now().toISOString() };
    delete entry.job.waitingFor;
    if (!this.anyWaiting()) this.stopWaitTick();
    this.emit();
    return this.status();
  }

  /** Chats changed (status, removed…): start waiting updates whose chats are all idle now. */
  sessionsChanged(): void {
    let changed = false;
    for (const [harness, entry] of this.entries) {
      const job = entry.job;
      if (job?.state !== "waiting") continue;
      const busy = this.options.busyChats(harness);
      if (busy === 0) {
        this.run(harness, entry);
        continue;
      }
      if (busy !== job.waitingFor) {
        job.waitingFor = busy;
        changed = true;
      }
    }
    if (!this.anyWaiting()) this.stopWaitTick();
    if (changed) this.emit();
  }

  // ── Checks ─────────────────────────────────────────────────────────────────────────────────

  /** `fresh`: the update's own check after it ran (its reading wins over older checks). */
  private async checkOne(harness: string, { fresh = false }: { fresh?: boolean } = {}): Promise<void> {
    const entry = this.entries.get(harness)!;
    const source = AGENT_VERSION_SOURCES[harness];
    const checkedAt = () => this.now().toISOString();
    const gen = entry.gen;
    if (!source) {
      entry.info = { ...entry.info, state: "unknown", reason: "Glade doesn't know where to find this agent's versions.", checkedAt: checkedAt() };
      return;
    }
    const [found, latest] = await Promise.all([
      this.readInstalledSafe(harness),
      source.latest({ fetchText: this.fetchText, claudeChannel: this.options.claudeChannel ?? (() => readClaudeChannel()) }).then(
        (l) => ({ ok: true as const, ...l }),
        (err: unknown) => ({ ok: false as const, reason: err instanceof SourceError ? err.message : `Couldn't get the newest version (${errorText(err)}).` }),
      ),
    ]);
    const info: AgentEntry["info"] = { harness, installed: null, latest: null, state: "unknown", checkedAt: checkedAt(), updateCommand: entry.info.updateCommand };
    if (latest.ok) {
      info.latest = latest.version;
      info.source = latest.source;
    }
    // An update finished meanwhile (or is running): its reading of the installed version wins.
    let installed = found;
    if (!fresh && (gen !== entry.gen || entry.job?.state === "running") && entry.info.installed) installed = { kind: "ok", version: entry.info.installed };
    if (installed.kind === "missing") info.state = "not-installed";
    else if (installed.kind === "error") Object.assign(info, { state: "failed", reason: installed.reason });
    else {
      info.installed = installed.version;
      if (!latest.ok) Object.assign(info, { state: "failed", reason: latest.reason });
      else info.state = compareVersions(installed.version, latest.version) < 0 ? "behind" : "up-to-date";
    }
    entry.info = info;
  }

  private async readInstalledSafe(harness: string): Promise<{ kind: "missing" } | { kind: "error"; reason: string } | { kind: "ok"; version: string }> {
    const custom = this.options.customCommand?.(harness);
    const command = custom ? formatCommandLine([custom.program, ...custom.args]) : (AGENT_VERSION_SOURCES[harness]?.command ?? harness);
    try {
      const found = await this.readInstalled(harness);
      if (!found.installed) return { kind: "missing" };
      if (!found.version) {
        const said = found.output.split("\n").filter(Boolean).pop()?.slice(0, 120);
        return { kind: "error", reason: `\`${command} --version\` didn't print a version${said ? ` ("${said}")` : ""}.` };
      }
      return { kind: "ok", version: found.version };
    } catch (err) {
      return { kind: "error", reason: `Couldn't run \`${command} --version\` (${errorText(err)}).` };
    }
  }

  // ── Updates ────────────────────────────────────────────────────────────────────────────────

  private run(harness: string, entry: AgentEntry): void {
    const job = entry.job!;
    job.state = "running";
    delete job.waitingFor;
    job.startedAt = this.now().toISOString();
    if (!this.anyWaiting()) this.stopWaitTick();
    const promise = this.execute(harness, entry, job).finally(() => this.runs.delete(harness));
    this.runs.set(harness, promise);
    this.emit();
  }

  private async execute(harness: string, entry: AgentEntry, job: AgentUpdateJob): Promise<void> {
    this.note(entry, `$ ${job.command}`);
    let code: number | null;
    try {
      code = await this.shell(job.command, this.options.cwd ?? homedir(), (chunk) => this.append(entry, chunk), new AbortController().signal);
    } catch (err) {
      return this.finish(entry, "failed", `\`${job.command}\` couldn't start: ${errorText(err)}.`);
    }
    if (code !== 0) return this.finish(entry, "failed", `\`${job.command}\` ${code === null ? "was stopped" : `exited with code ${code}`}.`);
    this.flush(entry);
    // Check this agent again (installed and newest), then reload its models (e.g. a model the old
    // version didn't know).
    await this.checkOne(harness, { fresh: true });
    entry.gen++;
    job.to = entry.info.installed;
    if (!job.to) this.note(entry, entry.info.state === "not-installed" ? "The agent's command isn't on the PATH anymore." : (entry.info.reason ?? "Couldn't read the new version."));
    this.emit();
    try {
      await this.options.onUpdated?.(harness);
    } catch (err) {
      this.note(entry, `Reloading the models failed: ${errorText(err)}.`);
    }
    this.finish(entry, "done");
  }

  private finish(entry: AgentEntry, state: "done" | "failed", error?: string): void {
    this.flush(entry);
    const job = entry.job!;
    job.state = state;
    if (error) job.error = error;
    job.endedAt = this.now().toISOString();
    this.emit();
  }

  private append(entry: AgentEntry, chunk: string): void {
    const job = entry.job!;
    const parts = (entry.partial + chunk.replace(/\r\n/g, "\n")).split("\n");
    entry.partial = (parts.pop() ?? "").slice(-MAX_LINE);
    for (const line of parts) {
      // Progress bars redraw with \r: keep what's shown last.
      const shown = line.split("\r").filter(Boolean).pop() ?? "";
      job.log.push(shown.slice(0, MAX_LINE));
    }
    if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
    this.emit();
  }

  private note(entry: AgentEntry, line: string): void {
    this.append(entry, `${entry.partial ? "\n" : ""}${line}\n`);
  }

  private flush(entry: AgentEntry): void {
    if (!entry.partial) return;
    const shown = entry.partial.split("\r").filter(Boolean).pop() ?? "";
    entry.partial = "";
    if (shown) entry.job!.log.push(shown);
    if (entry.job!.log.length > LOG_LINES) entry.job!.log.splice(0, entry.job!.log.length - LOG_LINES);
  }

  private jobView(entry: AgentEntry): AgentUpdateJob {
    const job = entry.job!;
    const partial = entry.partial.split("\r").filter(Boolean).pop();
    const log = partial ? [...job.log, partial] : [...job.log];
    return { ...job, log: log.slice(-LOG_LINES) };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────────────────

  private anyWaiting(): boolean {
    return [...this.entries.values()].some((e) => e.job?.state === "waiting");
  }

  private startWaitTick(): void {
    if (this.waitTimer || this.disposed) return;
    this.waitTimer = setInterval(() => this.sessionsChanged(), this.options.waitTickMs ?? 5_000);
    this.waitTimer.unref?.();
  }

  private stopWaitTick(): void {
    if (this.waitTimer) clearInterval(this.waitTimer);
    this.waitTimer = null;
  }

  /** Testing override, else the updater through the custom command in effect (I-201), else the built-in one. */
  private commandOf(harness: string): string | null {
    const override = this.options.updateCommands?.[harness];
    if (override && override !== AGENT_UPDATE_COMMANDS[harness]) return override;
    const custom = this.options.customCommand?.(harness) ?? null;
    if (custom) return agentUpdateCommand(harness, custom);
    return override ?? AGENT_UPDATE_COMMANDS[harness] ?? null;
  }

  private label(harness: string): string {
    return this.options.label?.(harness) ?? harness;
  }

  private emit(): void {
    if (this.disposed) return;
    this.options.onChange?.(this.status());
  }
}

/** Calls `send` at most every `ms` (the log can be chatty), always sending the last value. */
export function throttle<T>(send: (value: T) => void, ms = 250): (value: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  let last = 0;
  return (value) => {
    pending = { value };
    const wait = last + ms - Date.now();
    if (wait <= 0 && !timer) {
      last = Date.now();
      pending = null;
      send(value);
      return;
    }
    timer ??= setTimeout(
      () => {
        timer = null;
        last = Date.now();
        if (pending) send(pending.value);
        pending = null;
      },
      Math.max(wait, 0),
    );
  };
}
