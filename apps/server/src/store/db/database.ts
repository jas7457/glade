/**
 * Opens Glade's SQLite database (`<dataDir>/glade.db`, I-121) with Node's built-in `node:sqlite`
 * (Node ≥ 22.13; no native add-on to bundle). WAL mode so several servers on one data folder can
 * read while one writes (I-062), a busy timeout so writers wait for each other instead of failing,
 * and the numbered migrations in `migrations/` applied inside one immediate transaction (two
 * servers starting at once can't both migrate).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_VERSION, type Migration } from "./migrations/index.js";

export type Db = DatabaseSync;

export const DB_FILE = "glade.db";

/** How long a write waits for another connection's write lock before failing (ms). */
const BUSY_TIMEOUT_MS = 10_000;

export class NewerSchemaError extends Error {
  constructor(readonly found: number) {
    super(`The data folder's database was written by a newer Glade (schema ${found}, this one knows ${SCHEMA_VERSION}). Update Glade.`);
  }
}

export function openDatabase(path: string, migrations: readonly Migration[] = MIGRATIONS): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  migrate(db, migrations);
  return db;
}

export function schemaVersion(db: Db): number {
  return Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
}

/** Apply pending migrations (all in one immediate transaction). */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): void {
  const latest = migrations.at(-1)?.version ?? 0;
  if (schemaVersion(db) === latest) return;
  transaction(db, () => {
    const current = schemaVersion(db); // re-read under the write lock
    if (current > latest) throw new NewerSchemaError(current);
    for (const m of migrations) {
      if (m.version <= current) continue;
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    }
  });
}

let depth = new WeakMap<Db, number>();

/**
 * Run `fn` in a write transaction (`BEGIN IMMEDIATE`: takes the write lock up front, so a
 * read-then-write inside can't be interleaved with another server's write). Nested calls join
 * the outer transaction. `fn` must be synchronous.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  const level = depth.get(db) ?? 0;
  if (level > 0) {
    depth.set(db, level + 1);
    try {
      return fn();
    } finally {
      depth.set(db, level);
    }
  }
  db.exec("BEGIN IMMEDIATE");
  depth.set(db, 1);
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw err;
  } finally {
    depth.set(db, 0);
  }
}

/** Tests only: forget nesting state (a test that throws mid-transaction on a closed db). */
export function resetTransactionState(): void {
  depth = new WeakMap();
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function getMetaJson<T>(db: Db, key: string): T | null {
  const value = getMeta(db, key);
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function setMetaJson(db: Db, key: string, value: unknown): void {
  setMeta(db, key, JSON.stringify(value));
}
