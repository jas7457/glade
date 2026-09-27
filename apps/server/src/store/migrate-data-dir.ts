/**
 * One-time copy of the pre-rename data folder (I-059): `…/Application Support/pi-ui` → `…/Glade`.
 *
 * Runs at server start, before anything touches the data folder, and only when the new folder
 * doesn't exist yet and the old one does. The old folder is **copied, not moved**: it stays as a
 * backup (and keeps working for an old pi-ui build still installed). Copied: every file and
 * folder (workspaces/projects/settings/agents JSON, summaries, search index, scratch, …) except
 * the per-server runtime state (`servers/`, `leases/`, `*.lock` directories, `*.tmp` files),
 * which belongs to the servers running on the old folder.
 *
 * Standalone chats ran in `<old>/scratch`; their workspaces' `cwd` is pointed at `<new>/scratch`
 * (the copy) so the old folder really is just a backup. pi session files are referenced by
 * absolute path (`sessionRef`) and stay where they are.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";

/** Top-level entries never copied: other servers' runtime state. */
const SKIPPED = new Set(["servers", "leases", "server.lock"]);

function skipped(name: string): boolean {
  return SKIPPED.has(name) || name.endsWith(".lock") || name.endsWith(".tmp");
}

export interface DataDirMigration {
  from: string;
  to: string;
  /** Top-level entries copied. */
  copied: string[];
}

/**
 * Copies `oldDir` into `newDir` if `newDir` is missing and `oldDir` exists. Returns what was done,
 * or `null` when nothing had to be done. The copy is staged in a temp folder next to `newDir` and
 * renamed into place, so a crash half-way leaves no half-filled `newDir` (the next start retries).
 */
export function migrateLegacyDataDir(oldDir: string, newDir: string): DataDirMigration | null {
  if (existsSync(newDir) || !existsSync(oldDir)) return null;
  const staging = `${newDir}.migrating-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const copied: string[] = [];
  try {
    for (const name of readdirSync(oldDir)) {
      if (skipped(name)) continue;
      cpSync(join(oldDir, name), join(staging, name), {
        recursive: true,
        preserveTimestamps: true,
        // Nested lock dirs / temp files (e.g. under scratch/ they're the user's, keep those).
        filter: (src) => src === join(oldDir, name) || name === "scratch" || !skipped(basename(src)),
      });
      copied.push(name);
    }
    rewriteScratchCwd(join(staging, "workspaces.json"), join(oldDir, "scratch"), join(newDir, "scratch"));
    if (existsSync(newDir)) {
      // Another server migrated at the same time; keep theirs.
      rmSync(staging, { recursive: true, force: true });
      return null;
    }
    renameSync(staging, newDir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return { from: oldDir, to: newDir, copied: copied.sort() };
}

/** Points workspaces that ran in the old scratch folder (or below it) at the new one. */
function rewriteScratchCwd(file: string, oldScratch: string, newScratch: string): void {
  if (!existsSync(file)) return;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return; // unreadable: leave it to the store (it copes the same way it did before)
  }
  const workspaces = (data as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(workspaces)) return;
  let changed = false;
  for (const w of workspaces as Array<{ cwd?: unknown }>) {
    if (typeof w?.cwd !== "string") continue;
    if (w.cwd === oldScratch || w.cwd.startsWith(oldScratch + sep)) {
      w.cwd = newScratch + w.cwd.slice(oldScratch.length);
      changed = true;
    }
  }
  if (changed) writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
