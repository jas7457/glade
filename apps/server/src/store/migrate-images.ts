/**
 * Moves inline images out of the database into the blob store (I-157). Migration 5 only bumps the
 * schema (so an older Glade refuses the database); this does the data move after the database is
 * open, in small batches, so a large database never holds the write lock for long:
 *
 * - For each row of `messages`, `tool_results` and `events` whose JSON may hold an inline image,
 *   the images are written as blobs first, then the row is updated in its own short transaction,
 *   and only if it still holds the JSON we read (a row another server changed meanwhile is left
 *   for the next pass). A crash between the two leaves an unreferenced blob (collected by the GC)
 *   and the row still inline, so the next start simply does it again: idempotent and crash-safe.
 * - `meta.images_to_blobs = "done"` marks a completed pass; later starts skip the scan.
 * - Afterwards the freed pages can be returned to the file system with `VACUUM` (optional, only
 *   when no other server uses the data folder: see `vacuumIfAlone`).
 */
import { getMeta, setMeta, transaction, type Db } from "./db/database.js";
import type { BlobStore } from "./blobs.js";
import { externalizeImages, mayHaveInlineImage } from "./images.js";

export const IMAGES_TO_BLOBS_KEY = "images_to_blobs";

const TABLES = [
  { table: "messages", column: "payload_json" },
  { table: "tool_results", column: "payload_json" },
  { table: "events", column: "payload_json" },
] as const;

export interface ImageMigrationResult {
  /** Rows rewritten, per table. */
  rows: Record<string, number>;
  /** Images moved to blobs. */
  images: number;
  /** Rows left for the next pass (changed by another server while we worked). */
  skipped: number;
  /** Whether this call did the pass (false: already done). */
  ran: boolean;
}

export interface ImageMigrationOptions {
  batchSize?: number;
  /** Tests: called after each row's blobs are written, before the row is updated. */
  afterBlobs?: (table: string, rowid: number) => void;
  force?: boolean;
}

export function migrateInlineImages(db: Db, blobs: BlobStore, { batchSize = 50, afterBlobs, force = false }: ImageMigrationOptions = {}): ImageMigrationResult {
  const result: ImageMigrationResult = { rows: {}, images: 0, skipped: 0, ran: false };
  if (!force && getMeta(db, IMAGES_TO_BLOBS_KEY) === "done") return result;
  result.ran = true;
  for (const { table, column } of TABLES) {
    result.rows[table] = 0;
    const select = db.prepare(
      `SELECT rowid AS rid, ${column} AS json FROM ${table} WHERE rowid > ? AND ${column} LIKE '%"type":"image"%' AND ${column} LIKE '%"data":"%' ORDER BY rowid LIMIT ?`,
    );
    const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ? AND ${column} = ?`);
    let after = 0;
    for (;;) {
      const rows = select.all(after, batchSize) as Array<{ rid: number; json: string | null }>;
      if (!rows.length) break;
      after = Number(rows.at(-1)!.rid);
      const changes: Array<{ rid: number; before: string; after: string }> = [];
      for (const row of rows) {
        if (typeof row.json !== "string" || !mayHaveInlineImage(row.json)) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.json);
        } catch {
          continue;
        }
        const count = { n: 0 };
        const next = externalizeImages(parsed, blobs, count);
        if (next === parsed) continue;
        afterBlobs?.(table, Number(row.rid));
        result.images += count.n;
        changes.push({ rid: Number(row.rid), before: row.json, after: JSON.stringify(next) });
      }
      if (!changes.length) continue;
      transaction(db, () => {
        for (const c of changes) {
          const r = update.run(c.after, c.rid, c.before);
          if (Number(r.changes) > 0) result.rows[table]!++;
          else result.skipped++;
        }
      });
    }
  }
  if (result.images > 0) setMeta(db, "vacuum_pending", "1");
  if (result.skipped === 0) setMeta(db, IMAGES_TO_BLOBS_KEY, "done");
  return result;
}

/**
 * Give the freed pages back to the file system once (after the image move shrank the data).
 * `VACUUM` rewrites the whole file and needs the write lock for the duration; with WAL, a reader
 * on another server would keep the old pages alive (and the WAL would grow to the database's
 * size), so it only runs when `alone()` says no other server uses the folder. Otherwise it's
 * left for a later start (`meta.vacuum_pending`).
 */
export function vacuumIfAlone(db: Db, alone: () => boolean, log?: (line: string) => void): boolean {
  if (getMeta(db, "vacuum_pending") !== "1") return false;
  if (!alone()) return false;
  try {
    db.exec("VACUUM");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    setMeta(db, "vacuum_pending", "0");
    log?.("store: compacted the database after moving images out (VACUUM)");
    return true;
  } catch (err) {
    log?.(`store: VACUUM skipped: ${(err as Error).message}`);
    return false;
  }
}
