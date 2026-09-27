/**
 * `pnpm tauri:install --when-idle` helpers (I-058): find the installed app's server through the
 * data folder's server registry (`<dataDir>/servers/<pid>.json`, I-062) and ask it which chats
 * are busy (working or waiting for input) **on that server**. Sessions another server runs
 * (`activeElsewhere`, e.g. `pnpm dev`) don't count: restarting the app doesn't stop them.
 * Read-only: only GET requests.
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Same rule as the server's `defaultDataDir` on macOS (`GLADE_DATA_DIR`, else `PI_UI_DATA_DIR`). */
export function dataDir(env = process.env) {
  return env.GLADE_DATA_DIR || env.PI_UI_DATA_DIR || join(homedir(), "Library", "Application Support", "Glade");
}

/**
 * Data folders whose registries to search. With the default folder that includes the pre-rename
 * `…/pi-ui` one (I-059): an installed app from before the rename registers its server there.
 */
export function dataDirs(env = process.env, home = homedir()) {
  if (env.GLADE_DATA_DIR || env.PI_UI_DATA_DIR) return [dataDir(env)];
  const support = join(home, "Library", "Application Support");
  return [join(support, "Glade"), join(support, "pi-ui")];
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Registry entries of live servers of `kind` ("desktop" = the installed app) in one data folder,
 * or in several (`dirs` array; a server listed twice counts once).
 */
export function findServers(dir, kind = "desktop", isAlive = pidAlive) {
  if (Array.isArray(dir)) {
    const seen = new Map();
    for (const d of dir) for (const s of findServers(d, kind, isAlive)) if (!seen.has(s.pid)) seen.set(s.pid, s);
    return [...seen.values()];
  }
  let names = [];
  try {
    names = readdirSync(join(dir, "servers")).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const servers = [];
  for (const name of names) {
    try {
      const info = JSON.parse(readFileSync(join(dir, "servers", name), "utf8"));
      if (info.kind === kind && typeof info.pid === "number" && isAlive(info.pid)) servers.push(info);
    } catch {
      /* unreadable: skip */
    }
  }
  return servers;
}

/**
 * Busy chats (one per workspace) in a `GET /api/sessions` answer: sessions `working`/`blocked`
 * on that server. Returns `[{ workspaceId, titles }]`.
 */
export function busyChats(sessions) {
  const byWorkspace = new Map();
  for (const s of sessions) {
    if (s.status !== "working" && s.status !== "blocked") continue;
    if (s.activeElsewhere) continue;
    const entry = byWorkspace.get(s.workspaceId) ?? { workspaceId: s.workspaceId, titles: [] };
    entry.titles.push(s.title);
    byWorkspace.set(s.workspaceId, entry);
  }
  return [...byWorkspace.values()];
}

/** Busy chats on one server, or null if it can't be asked. */
export async function busyChatsOn(server, fetchImpl = fetch) {
  const host = server.host === "0.0.0.0" || !server.host ? "127.0.0.1" : server.host;
  try {
    const res = await fetchImpl(`http://${host}:${server.port}/api/sessions`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return busyChats(await res.json());
  } catch {
    return null;
  }
}

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/**
 * Resolve once no installed-app server has a busy chat, printing progress. Servers that don't
 * answer count as idle (nothing to protect).
 */
export async function waitUntilIdle({ dir = dataDirs(), intervalMs = 2000, log = console.log, write = (t) => process.stdout.write(t) } = {}) {
  const started = Date.now();
  const tty = process.stdout.isTTY;
  let lastLine = "";
  for (;;) {
    const servers = findServers(dir);
    const busy = [];
    for (const server of servers) busy.push(...((await busyChatsOn(server)) ?? []));
    if (!busy.length) {
      if (tty && lastLine) write("\n");
      log(servers.length ? "[install] the installed app is idle" : "[install] the installed app isn't running");
      return;
    }
    const titles = busy.map((b) => b.titles[0] ?? b.workspaceId);
    const shown = titles.slice(0, 3).join(", ") + (titles.length > 3 ? `, +${titles.length - 3} more` : "");
    const line = `[install] waiting for ${busy.length} chat${busy.length === 1 ? "" : "s"} on the installed app to finish (${shown}) — ${formatDuration(Date.now() - started)}`;
    if (tty) write(`\r\x1b[2K${line}`);
    else if (line.replace(/ — .*$/, "") !== lastLine.replace(/ — .*$/, "")) log(line);
    lastLine = line;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
