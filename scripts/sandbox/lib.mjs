/**
 * Sandbox helpers for `pnpm dev:agent` (I-052): isolated, self-cleaning Glade data for agents.
 *
 * A sandbox is one folder, `<root>/<name>` (root = /tmp/glade-sandbox), holding:
 *   sandbox.json  state: ports, supervisor/server/web pids, owners (ref-count), keep flag
 *   data/         GLADE_DATA_DIR of the sandbox server
 *   repo/         a small git repo the seeded project points at
 *   logs/         server.log, web.log, supervisor.log
 *
 * Every `pnpm dev:agent --name <name>` process is an *owner* (its pid is in `owners`). The first
 * one spawns a detached supervisor that runs server + web; later ones with the same name join it.
 * When the last owner leaves (or dies), the supervisor stops both and deletes the sandbox,
 * including the pi session files its chats created (`sessionRef`s in data/glade.db, I-121; and in
 * the older data/workspaces.json).
 *
 * The first half of this file is pure (unit-tested in lib.test.mjs); the rest does I/O.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * `GLADE_<name>`, else the pre-rename `PI_UI_<name>` (I-059; same rule as `env` in
 * apps/server/src/config.ts). Empty values count as unset.
 * @param {string} name @param {NodeJS.ProcessEnv} [source] @returns {string | undefined}
 */
export function env(name, source = process.env) {
  return source[`GLADE_${name}`] || source[`PI_UI_${name}`] || undefined;
}

export const DEFAULT_ROOT = env("SANDBOX_ROOT") || "/tmp/glade-sandbox";
/** Where sandboxes lived before the rename (I-059); still swept, and their ports still avoided. */
export const LEGACY_ROOT = "/tmp/pi-ui-sandbox";
/** Ports the user's own `pnpm dev` uses; a sandbox never takes them. */
export const RESERVED_PORTS = new Set([4317, 5317]);
/** Ownerless sandboxes older than this are removed by the sweep. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * Parses `dev:agent` arguments.
 * @param {string[]} argv
 * @returns {{ name: string, real: boolean, demo: boolean, keep: boolean, stop: boolean, sweep: boolean, help: boolean }}
 */
export function parseArgs(argv) {
  const out = { name: "agent", real: false, demo: false, keep: false, stop: false, sweep: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--name" || arg === "-n") {
      const value = argv[++i];
      if (!value) throw new Error("--name needs a value");
      out.name = value;
    } else if (arg.startsWith("--name=")) out.name = arg.slice("--name=".length);
    else if (arg === "--real") out.real = true;
    else if (arg === "--demo") out.demo = true;
    else if (arg === "--keep") out.keep = true;
    else if (arg === "--stop") out.stop = true;
    else if (arg === "--sweep") out.sweep = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (out.real && out.demo) throw new Error("--real and --demo can't be combined");
  if (!NAME_RE.test(out.name)) {
    throw new Error(`Invalid sandbox name "${out.name}" (letters, digits, . _ -; max 64 chars)`);
  }
  return out;
}

/**
 * The harness a sandbox runs (`GLADE_HARNESS`): the real pi, the website demo's scripted agents
 * (I-209), or the fake one.
 * @param {{ real: boolean, demo: boolean }} args @returns {"pi" | "demo" | "fake"}
 */
export function sandboxHarness(args) {
  return args.real ? "pi" : args.demo ? "demo" : "fake";
}

/**
 * Adds an owner (idempotent per pid). Returns a new state.
 * @template {{ owners: {pid:number, since:number}[] }} S
 * @param {S} state @param {number} pid @param {number} now @returns {S}
 */
export function addOwner(state, pid, now) {
  if (state.owners.some((o) => o.pid === pid)) return state;
  return { ...state, owners: [...state.owners, { pid, since: now }] };
}

/**
 * @template {{ owners: {pid:number, since:number}[] }} S
 * @param {S} state @param {number} pid @returns {S}
 */
export function removeOwner(state, pid) {
  return { ...state, owners: state.owners.filter((o) => o.pid !== pid) };
}

/**
 * Drops owners whose process is gone.
 * @template {{ owners: {pid:number, since:number}[] }} S
 * @param {S} state @param {(pid:number)=>boolean} isAlive @returns {S}
 */
export function pruneDeadOwners(state, isAlive) {
  return { ...state, owners: state.owners.filter((o) => isAlive(o.pid)) };
}

/**
 * What to do with an existing sandbox folder when another owner starts with the same name.
 * - `join`: a supervisor is alive → add ourselves as an owner.
 * - `reclaim`: nothing alive (crash leftovers) → clean it up and start fresh.
 * @param {null | { supervisorPid?: number|null, owners: {pid:number}[] }} state
 * @param {(pid:number)=>boolean} isAlive
 * @returns {"create" | "join" | "reclaim"}
 */
export function startDecision(state, isAlive) {
  if (!state) return "create";
  if (state.supervisorPid && isAlive(state.supervisorPid)) return "join";
  return "reclaim";
}

/**
 * Sweep decision for one sandbox folder: stale when no owner is alive and the sandbox was last
 * touched more than `maxAgeMs` ago. `force` ignores the age (`--sweep`). A crashed sandbox (its
 * supervisor died without cleaning up, not `--keep`) is stale right away so orphaned servers
 * don't linger. A folder without a readable sandbox.json is judged by its mtime only.
 * @param {{ state: null | { supervisorPid?: number|null, owners: {pid:number}[], updatedAt?: number }, mtimeMs: number }} entry
 * @param {{ now: number, isAlive: (pid:number)=>boolean, maxAgeMs?: number, force?: boolean }} opts
 * @returns {boolean}
 */
export function isStale({ state, mtimeMs }, { now, isAlive, maxAgeMs = STALE_AFTER_MS, force = false }) {
  if (state) {
    if (state.owners.some((o) => isAlive(o.pid))) return false;
    if (!state.keep && state.supervisorPid && !isAlive(state.supervisorPid)) return true;
    if (state.supervisorPid && isAlive(state.supervisorPid)) {
      // Owners are gone but the supervisor still runs: it is about to clean up (or wedged).
      if (!force && now - (state.updatedAt ?? mtimeMs) < maxAgeMs) return false;
    }
  }
  if (force) return true;
  const last = Math.max(state?.updatedAt ?? 0, mtimeMs);
  return now - last > maxAgeMs;
}

/**
 * The pi session files a sandbox's chats created, from its workspaces.json (and the pre-I-035
 * chats.json). Only absolute `.jsonl` paths inside `sessionsRoot` are returned, so a corrupt or
 * hostile index can never make cleanup delete anything else (fake-harness refs are ignored).
 * @param {unknown[]} indexes parsed workspaces.json / chats.json contents
 * @param {string} sessionsRoot e.g. ~/.pi/agent/sessions
 * @returns {string[]}
 */
export function collectSessionRefs(indexes, sessionsRoot) {
  const root = resolve(sessionsRoot);
  const refs = new Set();
  for (const index of indexes) {
    if (!index || typeof index !== "object") continue;
    const lists = [/** @type {any} */ (index).sessions, /** @type {any} */ (index).chats];
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const ref = item && typeof item === "object" ? item.sessionRef : null;
        if (typeof ref !== "string" || !isAbsolute(ref) || !ref.endsWith(".jsonl")) continue;
        const abs = resolve(ref);
        const rel = relative(root, abs);
        // Must be strictly inside the root and at least one folder deep (--<cwd>--/<file>).
        if (!rel || rel.startsWith("..") || isAbsolute(rel) || !rel.includes(sep)) continue;
        refs.add(abs);
      }
    }
  }
  return [...refs].sort();
}

/**
 * pi's session folder name for a working directory (mirrors pi's session-manager:
 * `--<cwd without leading slash, separators → ->--`).
 * @param {string} cwd absolute, already resolved @returns {string}
 */
export function piSessionFolderName(cwd) {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Picks `count` distinct ports using `probe` (returns an OS-assigned free port), skipping the
 * reserved ones, `exclude` (ports other sandboxes recorded) and duplicates.
 * @param {number} count @param {() => Promise<number>} probe @param {Iterable<number>} [exclude]
 * @returns {Promise<number[]>}
 */
export async function pickPorts(count, probe, exclude = []) {
  const taken = new Set(exclude);
  const ports = [];
  for (let tries = 0; ports.length < count; tries++) {
    if (tries > 50) throw new Error("Could not find free ports");
    const port = await probe();
    if (RESERVED_PORTS.has(port) || taken.has(port) || ports.includes(port)) continue;
    ports.push(port);
  }
  return ports;
}

// ---------------------------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------------------------

/** @param {number} pid */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === "EPERM";
  }
}

/** @returns {Promise<number>} a free loopback port chosen by the OS */
export function probeFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

export const sandboxDir = (name, root = DEFAULT_ROOT) => join(root, name);
export const statePath = (dir) => join(dir, "sandbox.json");
export const piSessionsRoot = () => join(homedir(), ".pi", "agent", "sessions");

/** @param {string} dir */
export function readState(dir) {
  try {
    return JSON.parse(readFileSync(statePath(dir), "utf8"));
  } catch {
    return null;
  }
}

/** @param {string} dir @param {object} state */
export function writeState(dir, state) {
  const file = statePath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2) + "\n");
  renameSync(tmp, file);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `fn` while holding `<root>/<name>.lock` (a mkdir lock, broken after 10s). Serialises
 * sandbox.json read-modify-write between owners, the supervisor and the sweep. Synchronous so
 * it also works inside `process.on("exit")`.
 * @template T @param {string} dir @param {() => T} fn @returns {T}
 */
export function withLock(dir, fn) {
  const lock = `${dir}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Sends `signal` to a process group we started (detached children lead their own group). */
export function killGroup(pid, signal = "SIGTERM") {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

/**
 * Deletes the pi session files a sandbox created (see {@link collectSessionRefs}) and then the
 * folders that held them, only if they are now empty. Returns the deleted files.
 * @param {string} dir sandbox folder @param {string} [sessionsRoot]
 */
export function deleteSandboxSessions(dir, sessionsRoot = piSessionsRoot()) {
  const indexes = ["workspaces.json", "chats.json"].map((f) => {
    try {
      return JSON.parse(readFileSync(join(dir, "data", f), "utf8"));
    } catch {
      return null;
    }
  });
  indexes.push(sessionsFromDatabase(join(dir, "data", "glade.db")));
  const refs = collectSessionRefs(indexes, sessionsRoot);
  for (const ref of refs) {
    rmSync(ref, { force: true });
    try {
      rmdirSync(dirname(ref)); // only succeeds when empty
    } catch {}
  }
  // pi creates the folder for a cwd even when it fails before writing a session: remove the
  // (empty only) folders of the sandbox's own working directories.
  const bases = new Set([resolve(dir)]);
  try {
    bases.add(realpathSync(dir));
  } catch {}
  for (const base of bases) {
    for (const cwd of [join(base, "repo"), join(base, "data", "scratch")]) {
      try {
        rmdirSync(join(sessionsRoot, piSessionFolderName(cwd)));
      } catch {}
    }
  }
  return refs;
}

/**
 * The session index in a data folder's `glade.db` (I-121), shaped like workspaces.json
 * (`{ sessions: [{ sessionRef }] }`), or null without a readable database. Read-only.
 * @param {string} path @returns {{ sessions: Array<{ sessionRef: string | null }> } | null}
 */
export function sessionsFromDatabase(path) {
  if (!existsSync(path)) return null;
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const rows = /** @type {Array<{ session_ref: string | null }>} */ (db.prepare("SELECT session_ref FROM sessions").all());
    return { sessions: rows.map((r) => ({ sessionRef: r.session_ref })) };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Stops whatever still runs for a sandbox and deletes it (session files first).
 * @param {string} dir @param {{ keep?: boolean }} [opts]
 */
export function destroySandbox(dir, { keep = false } = {}) {
  const state = readState(dir);
  if (state) {
    const pids = [state.serverPid, state.webPid, state.llamaPid, state.supervisorPid].filter(
      (pid) => pid && pid !== process.pid && isPidAlive(pid),
    );
    for (const pid of pids) killGroup(pid, "SIGTERM");
    // Wait for them to exit: a server writes its data files while shutting down, which would
    // race with the delete below.
    const deadline = Date.now() + 6000;
    while (pids.some(isPidAlive) && Date.now() < deadline) sleepSync(100);
    for (const pid of pids.filter(isPidAlive)) killGroup(pid, "SIGKILL");
    sleepSync(100);
  }
  if (keep) return [];
  const deleted = deleteSandboxSessions(dir);
  rmSync(dir, { recursive: true, force: true });
  return deleted;
}

/**
 * Removes stale sandboxes under `root` (see {@link isStale}). Returns the removed names.
 * @param {{ root?: string, force?: boolean, now?: number, skip?: string }} [opts]
 */
export function sweep({ root = DEFAULT_ROOT, force = false, now = Date.now(), skip } = {}) {
  if (!existsSync(root)) return [];
  const removed = [];
  for (const name of readdirNames(root)) {
    if (name === skip || name.endsWith(".lock") || !NAME_RE.test(name)) continue;
    const dir = join(root, name);
    try {
      withLock(dir, () => {
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(dir).mtimeMs;
        } catch {
          return;
        }
        const state = readState(dir);
        if (!isStale({ state, mtimeMs }, { now, isAlive: isPidAlive, force })) return;
        destroySandbox(dir);
        removed.push(name);
      });
    } catch (err) {
      console.warn(`[dev:agent] could not sweep ${dir}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return removed;
}

/**
 * Removes stale sandboxes left under the pre-rename root (see {@link LEGACY_ROOT}) and the root
 * itself once it's empty. Returns the removed names.
 * @param {{ force?: boolean, now?: number }} [opts]
 */
export function sweepLegacy({ force = false, now = Date.now() } = {}) {
  if (resolve(DEFAULT_ROOT) === resolve(LEGACY_ROOT)) return [];
  const removed = sweep({ root: LEGACY_ROOT, force, now });
  try {
    if (existsSync(LEGACY_ROOT) && readdirSync(LEGACY_ROOT).length === 0) rmdirSync(LEGACY_ROOT);
  } catch {
    /* another process uses it */
  }
  return removed;
}

/** Ports recorded by the sandboxes under `root` (a just-started one may not listen yet). */
export function sandboxPorts(root = DEFAULT_ROOT) {
  const ports = [];
  for (const r of new Set([root, LEGACY_ROOT])) {
    for (const name of readdirNames(r)) {
      const state = readState(join(r, name));
      if (state) ports.push(state.serverPort, state.webPort);
    }
  }
  return ports.filter((p) => Number.isInteger(p));
}

function readdirNames(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}
