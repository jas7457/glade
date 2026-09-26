/**
 * Data-dir lock (I-022): only one pi-ui server may use a data folder at a time, otherwise two
 * processes would write `chats.json`/`projects.json` and drive the same agent sessions.
 *
 * `<dataDir>/server.lock` holds {@link LockInfo} as JSON and is created exclusively. An existing
 * lock is stale (and replaced) when its pid is dead or its port doesn't answer
 * `GET /api/settings` within ~1s. Otherwise acquiring throws {@link DataDirInUseError}; the entry
 * point exits with code 3. The desktop app reads the lock to reuse a running server.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = "server.lock";
/** Exit code when another server owns the data folder. */
export const EXIT_DATA_DIR_IN_USE = 3;

export interface LockInfo {
  pid: number;
  port: number;
  host: string;
  /** Who runs it: "dev" (pnpm dev/start) or "desktop" (the app). From `PI_UI_SERVER_KIND`. */
  kind: string;
  startedAt: number;
}

export class DataDirInUseError extends Error {
  constructor(readonly holder: LockInfo) {
    super(
      `The pi-ui data folder is in use by the ${holder.kind} server on http://${formatHost(holder.host)}:${holder.port} (pid ${holder.pid}). ` +
        "Quit it first — or open that URL.",
    );
  }
}

export interface DataLock {
  readonly path: string;
  readonly info: LockInfo;
  /** Record the port actually listened on. */
  update(patch: Partial<Pick<LockInfo, "port" | "host">>): void;
  /** Remove the lock file if it's still ours. Idempotent and synchronous (safe in `exit`). */
  release(): void;
}

export interface AcquireOptions {
  kind: string;
  host: string;
  port: number;
  pid?: number;
  /** Is this process alive? Default: `process.kill(pid, 0)` (ESRCH = dead). */
  isAlive?: (pid: number) => boolean;
  /** Does a pi-ui server answer at host:port? Default: `GET /api/settings` with a 1s timeout. */
  probe?: (host: string, port: number) => Promise<boolean>;
}

export async function acquireDataLock(dataDir: string, options: AcquireOptions): Promise<DataLock> {
  const path = join(dataDir, LOCK_FILE);
  const isAlive = options.isAlive ?? pidIsAlive;
  const probe = options.probe ?? probeServer;
  let info: LockInfo = {
    pid: options.pid ?? process.pid,
    port: options.port,
    host: options.host,
    kind: options.kind,
    startedAt: Date.now(),
  };
  mkdirSync(dataDir, { recursive: true });

  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, JSON.stringify(info), { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 5) throw err;
    }
    const holder = readLock(path);
    if (holder && holder.pid !== info.pid && isAlive(holder.pid) && (await probe(holder.host, holder.port))) {
      throw new DataDirInUseError(holder);
    }
    // Stale (dead pid, unresponsive port, unreadable, or left by this very pid): replace it.
    // Another process may race us to it; the exclusive create on the next attempt decides.
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  let released = false;
  const isOurs = () => {
    const current = readLock(path);
    return current?.pid === info.pid && current.startedAt === info.startedAt;
  };
  return {
    path,
    get info() {
      return info;
    },
    update(patch) {
      if (released || !isOurs()) return;
      info = { ...info, ...patch };
      writeFileSync(path, JSON.stringify(info));
    },
    release() {
      if (released) return;
      released = true;
      try {
        if (isOurs()) unlinkSync(path);
      } catch {
        /* already gone */
      }
    },
  };
}

export function readLock(path: string): LockInfo | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    if (typeof value.pid !== "number" || typeof value.port !== "number") return null;
    return {
      pid: value.pid,
      port: value.port,
      host: typeof value.host === "string" ? value.host : "127.0.0.1",
      kind: typeof value.kind === "string" ? value.kind : "unknown",
      startedAt: typeof value.startedAt === "number" ? value.startedAt : 0,
    };
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function probeServer(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${formatHost(connectHost(host))}:${port}/api/settings`, {
      signal: AbortSignal.timeout(1000),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/** A wildcard bind address can't be connected to; use loopback instead. */
function connectHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
