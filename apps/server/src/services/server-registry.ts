/**
 * Per-server registry (I-062, replaces the I-022 data-dir lock). Several pi-ui servers may use
 * one data folder (e.g. `pnpm dev` and the installed app); each one announces itself in
 * `<dataDir>/servers/<id>.json` (`id` = its pid) and rewrites the file every few seconds
 * (heartbeat). Session leases (leases.ts) name the server that runs a session's agent; a lease
 * whose server is gone (file missing, pid dead, or heartbeat too old) is stale and may be taken.
 * The files are also handy for diagnostics: `ls <dataDir>/servers`.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SERVERS_DIR = "servers";
export const HEARTBEAT_MS = 2_000;
/**
 * A server whose pid is alive but hasn't written a heartbeat for this long is considered hung.
 * Generous on purpose: a dead pid is detected immediately; this only covers hangs and pid reuse.
 */
export const STALE_SERVER_MS = 60_000;

export interface ServerInfo {
  /** Registry id (file name); the pid by default. */
  id: string;
  pid: number;
  /** "dev" (pnpm dev/start) or "desktop" (the app), from `PI_UI_SERVER_KIND`. */
  kind: string;
  host: string;
  port: number;
  startedAt: number;
  heartbeatAt: number;
}

export interface ServerRegistryOptions {
  kind: string;
  host: string;
  port: number;
  /** Registry id; defaults to the pid (tests run two servers in one process). */
  id?: string;
  pid?: number;
  heartbeatMs?: number;
  staleMs?: number;
  /** Is this process alive? Default: `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
}

export class ServerRegistry {
  readonly dir: string;
  private info: ServerInfo;
  private timer: NodeJS.Timeout | null = null;
  private released = false;
  private readonly isAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly staleMs: number;
  /** When our own heartbeat last ran: after a long gap (sleep) we don't judge others stale yet. */
  private lastBeat = 0;

  constructor(dataDir: string, private readonly options: ServerRegistryOptions) {
    this.dir = join(dataDir, SERVERS_DIR);
    this.now = options.now ?? Date.now;
    this.isAlive = options.isAlive ?? pidIsAlive;
    this.staleMs = options.staleMs ?? STALE_SERVER_MS;
    const pid = options.pid ?? process.pid;
    const now = this.now();
    this.info = { id: options.id ?? String(pid), pid, kind: options.kind, host: options.host, port: options.port, startedAt: now, heartbeatAt: now };
  }

  get self(): ServerInfo {
    return this.info;
  }

  get id(): string {
    return this.info.id;
  }

  /** Write our file, remove files of dead servers, and start the heartbeat. */
  start(): void {
    mkdirSync(this.dir, { recursive: true });
    this.beat();
    this.prune();
    const ms = this.options.heartbeatMs ?? HEARTBEAT_MS;
    if (ms > 0) {
      let beats = 0;
      this.timer = setInterval(() => {
        this.beat();
        if (++beats % 10 === 0) this.prune();
      }, ms);
      this.timer.unref();
    }
  }

  /** Remove the files of servers that are gone (crashed without cleaning up). */
  prune(): void {
    for (const server of this.list()) {
      if (server.id !== this.info.id && !this.isLiveInfo(server)) this.remove(server.id);
    }
  }

  /** Record the address actually listened on. */
  update(patch: Partial<Pick<ServerInfo, "host" | "port">>): void {
    this.info = { ...this.info, ...patch };
    this.beat();
  }

  /** Rewrite our file with a fresh heartbeat. */
  beat(): void {
    if (this.released) return;
    const now = this.now();
    this.lastBeat = now;
    this.info = { ...this.info, heartbeatAt: now };
    const path = this.pathOf(this.info.id);
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.info));
      renameSync(tmp, path);
    } catch {
      /* data folder gone (e.g. a test cleaning up); next beat retries */
    }
  }

  /** Every readable server file (live or not). */
  list(): ServerInfo[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    return names.map((n) => this.read(n.slice(0, -5))).filter((s): s is ServerInfo => s !== null);
  }

  /** Other live servers on this data folder. */
  others(): ServerInfo[] {
    return this.list().filter((s) => s.id !== this.info.id && this.isLiveInfo(s));
  }

  read(id: string): ServerInfo | null {
    try {
      const value = JSON.parse(readFileSync(this.pathOf(id), "utf8")) as Partial<ServerInfo>;
      if (typeof value.pid !== "number" || typeof value.heartbeatAt !== "number") return null;
      return {
        id,
        pid: value.pid,
        kind: typeof value.kind === "string" ? value.kind : "unknown",
        host: typeof value.host === "string" ? value.host : "127.0.0.1",
        port: typeof value.port === "number" ? value.port : 0,
        startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
        heartbeatAt: value.heartbeatAt,
      };
    } catch {
      return null;
    }
  }

  /** Is server `id` running (ours always is)? */
  isLive(id: string): boolean {
    if (id === this.info.id) return !this.released;
    const info = this.read(id);
    return info !== null && this.isLiveInfo(info);
  }

  /**
   * True if we may judge other servers by their heartbeat: our own heartbeat ran recently. After
   * the machine slept every heartbeat is old, ours included; wait for the others to beat again.
   */
  canJudgeHeartbeats(): boolean {
    const ms = this.options.heartbeatMs ?? HEARTBEAT_MS;
    return ms <= 0 || this.now() - this.lastBeat < ms * 3;
  }

  private isLiveInfo(info: ServerInfo): boolean {
    if (!this.isAlive(info.pid)) return false;
    if (!this.canJudgeHeartbeats()) return true;
    return this.now() - info.heartbeatAt < this.staleMs;
  }

  /** Stop the heartbeat and delete our file. Synchronous and idempotent (safe in `exit`). */
  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.released) return;
    this.released = true;
    this.remove(this.info.id);
  }

  private remove(id: string): void {
    try {
      unlinkSync(this.pathOf(id));
    } catch {
      /* already gone */
    }
  }

  private pathOf(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}

export function pidIsAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
