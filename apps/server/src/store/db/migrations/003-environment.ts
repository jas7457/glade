/**
 * Migration 3 (I-123): environments. Every server (data folder) is an environment with a
 * permanent id (a ULID in `meta.environment_id`, created here or on first start); every project
 * belongs to one. Projects from before are filled in with this environment's id, in the
 * `environment_id` column (added by migration 1, unused until now) and in `data_json`.
 * Additive: a schema-2 server still running ignores both.
 */
import type { Db } from "../database.js";
import { ulid } from "../ids.js";

export const ENVIRONMENT_ID_KEY = "environment_id";

/** This data folder's environment id, created when missing (callers hold a transaction). */
export function ensureEnvironmentId(db: Db): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(ENVIRONMENT_ID_KEY) as { value: string } | undefined;
  if (row?.value) return row.value;
  const id = ulid();
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(ENVIRONMENT_ID_KEY, id);
  return id;
}

export const migration003 = {
  version: 3,
  name: "environment",
  sql: "",
  run(db: Db): void {
    const id = ensureEnvironmentId(db);
    db.prepare(
      `UPDATE projects SET environment_id = ?, data_json = json_set(data_json, '$.environmentId', ?)
       WHERE environment_id IS NULL OR json_extract(data_json, '$.environmentId') IS NULL`,
    ).run(id, id);
  },
};
