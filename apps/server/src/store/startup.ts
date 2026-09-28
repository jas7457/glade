/**
 * Moving from the JSON files to `glade.db` safely (I-121, user decisions in
 * docs/design/environments-and-store.md §5.4):
 *
 * - **Older server guard.** A Glade from before the database announces no `storeSchema` in
 *   `servers/<pid>.json`. While one runs on the data folder, a new server doesn't open (or import
 *   into) the database: the old one keeps writing JSON that the database would no longer read.
 *   The server waits in a "Quit the older Glade first" state instead (`index.ts`).
 * - **Confirming the migration.** The JSON files are imported on the first start and left as
 *   they were. Every successful start is counted (`meta.successful_starts`); after
 *   {@link CLEANUP_AFTER_STARTS} of them, with no older server registered, the imported files are
 *   deleted (`meta.json_cleanup`). Files that couldn't be read are never deleted.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ServerInfo, ServerRegistry } from "../services/server-registry.js";
import { getMetaJson, setMetaJson, transaction } from "./db/database.js";
import { LEGACY_JSON_DIRS, LEGACY_JSON_FILES } from "./import-json.js";
import type { JsonImportRecord, Store } from "./store.js";

/** Successful starts of the new version before the imported JSON files are deleted. */
export const CLEANUP_AFTER_STARTS = 3;

export const OLDER_SERVER_MESSAGE =
  "An older version of Glade is running on this data folder. Quit it first: this version keeps your chats in a new database and imports them once the older one is gone.";

export function olderServerMessage(servers: readonly ServerInfo[]): string {
  const where = servers.map((s) => `${s.kind === "desktop" ? "the Glade app" : `a ${s.kind} server`} (pid ${s.pid}${s.port ? `, port ${s.port}` : ""})`);
  return `${OLDER_SERVER_MESSAGE}${where.length ? ` Running: ${where.join(", ")}.` : ""}`;
}

export interface StartRecord {
  starts: number;
  /** What the cleanup deleted this time (empty when it didn't run). */
  deleted: string[];
}

/**
 * Count a successful start and, once the migration is confirmed, delete the imported JSON files.
 * Call once the server is listening.
 */
export function recordSuccessfulStart(store: Store, registry: ServerRegistry | null, log?: (msg: string) => void): StartRecord {
  const db = store.db;
  const starts = transaction(db, () => {
    const next = (getMetaJson<number>(db, "successful_starts") ?? 0) + 1;
    setMetaJson(db, "successful_starts", next);
    return next;
  });
  return { starts, deleted: cleanupImportedJson(store, registry, starts, log) };
}

/** Delete the imported JSON files if the migration is confirmed. Returns what was deleted. */
export function cleanupImportedJson(store: Store, registry: ServerRegistry | null, starts: number, log?: (msg: string) => void): string[] {
  const db = store.db;
  if (starts < CLEANUP_AFTER_STARTS) return [];
  if (getMetaJson(db, "json_cleanup") !== null) return [];
  const older = registry?.olderServers() ?? [];
  if (older.length) {
    log?.(`kept the old JSON files: an older Glade is still registered on the data folder`);
    return [];
  }
  const record = getMetaJson<JsonImportRecord>(db, "json_import");
  if (!record) return [];
  const failed = new Set(record.failed.map((f) => f.file));
  const candidates = [...LEGACY_JSON_FILES, ...LEGACY_JSON_DIRS].filter((f) => record.files.includes(f) && !failed.has(f));
  const deleted: string[] = [];
  for (const name of candidates) {
    const path = join(store.dataDir, name);
    try {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
        deleted.push(name);
      }
      // The JSON store's short write locks (`<file>.lock/`), if a crashed server left one.
      rmSync(`${path}.lock`, { recursive: true, force: true });
    } catch (err) {
      log?.(`could not delete ${path}: ${(err as Error).message}`);
    }
  }
  setMetaJson(db, "json_cleanup", { at: Date.now(), deleted });
  if (deleted.length) log?.(`the move to glade.db is confirmed; deleted the old JSON files: ${deleted.join(", ")}`);
  return deleted;
}
