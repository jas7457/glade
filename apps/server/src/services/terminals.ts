/**
 * Terminal tabs (I-187): login shells on pseudo-terminals, one per terminal tab, in the
 * workspace's folder. Harness-neutral (terminals belong to the workspace, not an agent).
 *
 * - `start` spawns `$SHELL -l` (node-pty by default; injectable for tests) or returns the running
 *   one; after an exit it starts a new shell under the same id (Restart), keeping the scrollback.
 * - Output is appended to a scrollback buffer (the newest {@link TERMINAL_LIMITS.scrollbackChars},
 *   trimmed at a line break) and streamed to attached clients in small batches, so reopening a tab
 *   or reloading the page restores recent output (`snapshot`).
 * - Shells keep running while this server runs, attached or not, until the tab is closed (`kill`:
 *   SIGHUP, like closing a terminal window), their workspace is deleted, or the server stops.
 * - Backpressure: a client whose socket buffer is over {@link HIGH_WATER} pauses the pty until it
 *   drains, so `yes` can't fill the server's memory.
 *
 * Shells get the server's environment minus Glade's own variables (`piChildEnv`) and package
 * manager noise, plus TERM=xterm-256color, COLORTERM=truecolor, TERM_PROGRAM=Glade and a UTF-8
 * locale when none is set (the desktop app starts without one).
 */
import { accessSync, chmodSync, constants, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { TERMINAL_LIMITS, type TerminalExit, type TerminalInfo, type TerminalServerMessage } from "@glade/protocol";
import { piChildEnv } from "../harness/pi/child-env.js";
import { VERSION } from "../config.js";

/** The subset of node-pty's `IPty` we use. */
export interface Pty {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause?(): void;
  resume?(): void;
}

export interface PtySpawnOptions {
  name: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export type SpawnPty = (file: string, args: string[], options: PtySpawnOptions) => Pty;

/** One attached browser tab (a `/ws/terminal/:id` socket). */
export interface TerminalClient {
  send(message: TerminalServerMessage): void;
  /** Bytes queued on the socket (for backpressure). */
  bufferedAmount?(): number;
}

export interface TerminalAttachment {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

export class TerminalError extends Error {
  constructor(
    readonly status: 400 | 404 | 501,
    message: string,
  ) {
    super(message);
  }
}

export interface TerminalServiceOptions {
  /** The workspace's folder, or null when there's no such workspace. */
  cwdOf: (workspaceId: string) => string | null;
  /** Default: node-pty, loaded on first use. */
  spawn?: SpawnPty;
  /** Default: `$SHELL`, else the user's login shell, else /bin/zsh. */
  shell?: string;
  env?: NodeJS.ProcessEnv;
  scrollbackChars?: number;
  /** Output batching window (ms). */
  flushMs?: number;
  log?: (message: string) => void;
}

/** Pause the pty while a client has more than this queued (bytes). */
export const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 512 * 1024;
const DRAIN_POLL_MS = 50;

interface Terminal {
  info: TerminalInfo;
  pty: Pty | null;
  chunks: string[];
  size: number;
  clients: Set<TerminalClient>;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
  paused: boolean;
  drainTimer: ReturnType<typeof setInterval> | null;
  disposers: Array<{ dispose(): void }>;
}

const clampInt = (n: unknown, min: number, max: number, fallback: number) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;

export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  return {
    cols: clampInt(cols, TERMINAL_LIMITS.minCols, TERMINAL_LIMITS.maxCols, 80),
    rows: clampInt(rows, TERMINAL_LIMITS.minRows, TERMINAL_LIMITS.maxRows, 24),
  };
}

export class TerminalService {
  private readonly terminals = new Map<string, Terminal>();
  private readonly scrollbackChars: number;
  private readonly flushMs: number;
  private spawnPty: SpawnPty | null;
  private disposed = false;

  constructor(private readonly options: TerminalServiceOptions) {
    this.spawnPty = options.spawn ?? null;
    this.scrollbackChars = options.scrollbackChars ?? TERMINAL_LIMITS.scrollbackChars;
    this.flushMs = options.flushMs ?? 4;
  }

  /** Start the tab's shell, or return the running one (an exited one is restarted). */
  async start(workspaceId: string, terminalId: string, size: { cols: number; rows: number }): Promise<TerminalInfo> {
    if (this.disposed) throw new TerminalError(501, "The server is shutting down.");
    const existing = this.terminals.get(terminalId);
    if (existing && existing.info.workspaceId !== workspaceId) throw new TerminalError(400, "That terminal belongs to another chat.");
    if (existing && !existing.info.exit) return { ...existing.info };
    const folder = this.options.cwdOf(workspaceId);
    if (folder === null) throw new TerminalError(404, "Chat not found");
    const cwd = isDirectory(folder) ? folder : homedir();
    const spawn = await this.loadSpawn();
    const shell = this.shell();
    const { cols, rows } = clampSize(size.cols, size.rows);
    let pty: Pty;
    try {
      pty = spawn(shell, ["-l"], { name: "xterm-256color", cwd, env: this.env(), cols, rows });
    } catch (err) {
      throw new TerminalError(501, `Couldn't start ${shell}: ${(err as Error).message}`);
    }
    const info: TerminalInfo = { id: terminalId, workspaceId, cwd, shell, pid: pty.pid, cols, rows, startedAt: Date.now(), exit: null };
    const term: Terminal = existing ?? {
      info,
      pty: null,
      chunks: [],
      size: 0,
      clients: new Set(),
      pending: "",
      flushTimer: null,
      paused: false,
      drainTimer: null,
      disposers: [],
    };
    term.info = info;
    term.pty = pty;
    term.paused = false;
    term.disposers = [
      pty.onData((data) => this.onData(term, data)),
      pty.onExit((e) => this.onExit(term, pty, { code: e.exitCode, signal: e.signal ? e.signal : null })),
    ];
    this.terminals.set(terminalId, term);
    this.options.log?.(`terminal ${terminalId} started: ${shell} (pid ${pty.pid}) in ${cwd}`);
    if (existing) for (const client of term.clients) client.send({ type: "started", info: { ...info } });
    return { ...info };
  }

  /** Attach a client: it gets the scrollback now, then live output. Null when there's no such shell. */
  attach(terminalId: string, client: TerminalClient): TerminalAttachment | null {
    const term = this.terminals.get(terminalId);
    if (!term) return null;
    this.flush(term);
    this.trim(term);
    client.send({ type: "snapshot", data: term.chunks.join(""), info: { ...term.info } });
    term.clients.add(client);
    return {
      input: (data) => {
        if (typeof data === "string" && data && term.pty && !term.info.exit) term.pty.write(data);
      },
      resize: (cols, rows) => {
        const size = clampSize(cols, rows);
        if (!term.pty || term.info.exit || (size.cols === term.info.cols && size.rows === term.info.rows)) return;
        term.info.cols = size.cols;
        term.info.rows = size.rows;
        try {
          term.pty.resize(size.cols, size.rows);
        } catch {
          /* exited meanwhile */
        }
      },
      detach: () => {
        term.clients.delete(client);
        this.checkDrain(term);
      },
    };
  }

  /** The shells of a workspace running (or exited) on this server. */
  list(workspaceId: string): TerminalInfo[] {
    return [...this.terminals.values()].filter((t) => t.info.workspaceId === workspaceId).map((t) => ({ ...t.info }));
  }

  get(terminalId: string): TerminalInfo | null {
    const term = this.terminals.get(terminalId);
    return term ? { ...term.info } : null;
  }

  /** Close a tab: SIGHUP its shell and forget it. False when there's no such shell. */
  kill(terminalId: string): boolean {
    const term = this.terminals.get(terminalId);
    if (!term) return false;
    this.terminals.delete(terminalId);
    this.stop(term);
    this.options.log?.(`terminal ${terminalId} closed`);
    return true;
  }

  /** A workspace was deleted: close its shells. */
  killWorkspace(workspaceId: string): void {
    for (const term of [...this.terminals.values()]) if (term.info.workspaceId === workspaceId) this.kill(term.info.id);
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.terminals.keys()]) this.kill(id);
  }

  private stop(term: Terminal): void {
    if (term.flushTimer) clearTimeout(term.flushTimer);
    if (term.drainTimer) clearInterval(term.drainTimer);
    term.flushTimer = term.drainTimer = null;
    for (const d of term.disposers) d.dispose();
    term.disposers = [];
    const pty = term.pty;
    term.pty = null;
    term.clients.clear();
    if (pty && !term.info.exit) {
      try {
        pty.kill("SIGHUP");
      } catch {
        /* already gone */
      }
    }
  }

  private onData(term: Terminal, data: string): void {
    term.chunks.push(data);
    term.size += data.length;
    if (term.size > this.scrollbackChars * 1.25) this.trim(term);
    if (term.clients.size === 0) return;
    term.pending += data;
    term.flushTimer ??= setTimeout(() => this.flush(term), this.flushMs);
  }

  private onExit(term: Terminal, pty: Pty, exit: TerminalExit): void {
    if (term.pty !== pty) return;
    this.flush(term);
    term.info.exit = exit;
    if (term.drainTimer) clearInterval(term.drainTimer);
    term.drainTimer = null;
    for (const d of term.disposers) d.dispose();
    term.disposers = [];
    term.pty = null;
    this.options.log?.(`terminal ${term.info.id} exited with code ${exit.code}`);
    for (const client of term.clients) client.send({ type: "exit", exit });
  }

  private flush(term: Terminal): void {
    if (term.flushTimer) clearTimeout(term.flushTimer);
    term.flushTimer = null;
    if (!term.pending) return;
    const data = term.pending;
    term.pending = "";
    for (const client of term.clients) client.send({ type: "output", data });
    this.checkDrain(term);
  }

  /** Pause the pty while any client is far behind; resume once they've caught up. */
  private checkDrain(term: Terminal): void {
    const behind = (limit: number) => [...term.clients].some((c) => (c.bufferedAmount?.() ?? 0) > limit);
    if (!term.paused && term.pty?.pause && behind(HIGH_WATER)) {
      term.paused = true;
      term.pty.pause();
      term.drainTimer = setInterval(() => this.checkDrain(term), DRAIN_POLL_MS);
    } else if (term.paused && !behind(LOW_WATER)) {
      term.paused = false;
      if (term.drainTimer) clearInterval(term.drainTimer);
      term.drainTimer = null;
      term.pty?.resume?.();
    }
  }

  /** Keep the newest `scrollbackChars`, cut at a line break so we don't start mid-sequence. */
  private trim(term: Terminal): void {
    let all = term.chunks.join("");
    let cut = all.length - this.scrollbackChars;
    if (cut <= 0) return;
    const nl = all.indexOf("\n", cut);
    if (nl !== -1 && nl - cut < 64 * 1024) cut = nl + 1;
    all = all.slice(cut);
    term.chunks = [all];
    term.size = all.length;
  }

  private shell(): string {
    if (this.options.shell) return this.options.shell;
    const env = this.options.env ?? process.env;
    const candidates = [env.SHELL, safeLoginShell(), "/bin/zsh", "/bin/bash", "/bin/sh"];
    return candidates.find((s): s is string => !!s && s.startsWith("/") && existsSync(s)) ?? "/bin/sh";
  }

  private env(): NodeJS.ProcessEnv {
    const base = piChildEnv(this.options.env ?? process.env);
    for (const key of Object.keys(base)) {
      // `pnpm dev` noise and the terminal the server was started from.
      if (/^(npm_|PNPM_|INIT_CWD$|TERM_SESSION_ID$|ITERM_|TMUX|STY$|VSCODE_)/.test(key)) delete base[key];
    }
    const env: NodeJS.ProcessEnv = {
      ...base,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "Glade",
      TERM_PROGRAM_VERSION: VERSION,
    };
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = "en_US.UTF-8";
    return env;
  }

  private async loadSpawn(): Promise<SpawnPty> {
    if (this.spawnPty) return this.spawnPty;
    try {
      ensureSpawnHelperExecutable();
      // CommonJS module: the named export in Node, `default` in some bundlers.
      const pty = (await import("node-pty")) as Partial<typeof import("node-pty")> & { default?: typeof import("node-pty") };
      const mod = (pty.spawn ? pty : pty.default) as typeof import("node-pty");
      this.spawnPty = (file, args, opts) => mod.spawn(file, args, { ...opts, env: opts.env as Record<string, string> });
      return this.spawnPty;
    } catch (err) {
      throw new TerminalError(501, `Terminals aren't available on this server: ${(err as Error).message}`);
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeLoginShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * node-pty's macOS prebuilds ship `spawn-helper` without the executable bit (npm tarball), and
 * pnpm keeps it that way, which makes every spawn fail with "posix_spawnp failed". Fix it once.
 */
function ensureSpawnHelperExecutable(): void {
  let dir: string;
  try {
    dir = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  } catch {
    return;
  }
  for (const helper of [join(dir, "build", "Release", "spawn-helper"), join(dir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper")]) {
    if (!existsSync(helper)) continue;
    try {
      accessSync(helper, constants.X_OK);
    } catch {
      try {
        chmodSync(helper, 0o755);
      } catch {
        /* read-only install: spawn reports the error */
      }
    }
  }
}
