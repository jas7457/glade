/**
 * Moves images into per-chat folders (I-163; before that, I-157 moved inline images out of the
 * database into shared content-addressed files). Migration 6 only bumps the schema (so an older
 * Glade refuses the database); this does the data move after the database is open, in small
 * batches, so a large database never holds the write lock for long:
 *
 * - For each row of `messages`, `tool_results` and `events` (of a chat) that holds an inline image
 *   or a legacy `sha256:` reference, the image is written, or the shared file **copied** (not
 *   moved: a file two chats shared becomes one copy per chat), into the row's chat folder first.
 *   Then the row is updated in a short transaction, and only if it still holds the JSON we read
 *   (a row another server changed meanwhile is left for the next pass). A crash between the two
 *   leaves a file the next pass finds again (names are stable per content) and the row as it was,
 *   so the next start simply does it again: idempotent and crash-safe, also with two servers
 *   running the pass at once.
 * - `meta.images_per_chat = "done"` marks a completed pass; later starts skip the scan.
 * - Once done, the legacy shared files no row references any more (by then: none) are deleted.
 * - Attached files move too (`moveAttachmentsIntoChats`): `<dataDir>/attachments/<sessionId>/`
 *   becomes `<dataDir>/chats/<sessionId>/files/`, so a chat's folder holds everything it owns.
 * - Afterwards the freed pages can be returned to the file system with `VACUUM` (optional, only
 *   when no other server uses the data folder: see `vacuumIfAlone`).
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { getMeta, setMeta, transaction, type Db } from "./db/database.js";
import { CHATS_DIR, type BlobStore } from "./blobs.js";
import { externalizeImages, legacyBlobRefsIn } from "./images.js";

export const IMAGES_PER_CHAT_KEY = "images_per_chat";

const INLINE = `(payload_json LIKE '%"type":"image"%' AND payload_json LIKE '%"data":"%')`;
const LEGACY = `payload_json LIKE '%"blob":"sha256:%'`;

/**
 * The rows that may hold images, only of chats that still exist (rows of a deleted chat would
 * only leave a folder nobody deletes; their legacy files go with the rest).
 */
const OF_A_CHAT = "session_id IN (SELECT id FROM sessions)";
const TABLES = ["messages", "tool_results", "events"] as const;

export interface ImageMigrationResult {
  /** Rows rewritten, per table. */
  rows: Record<string, number>;
  /** Images written or copied into chat folders. */
  images: number;
  /** References whose file was already gone (left as they were). */
  missing: number;
  /** Rows left for the next pass (changed by another server while we worked). */
  skipped: number;
  /** Legacy shared files deleted afterwards. */
  legacyDeleted: number;
  /** Whether this call did the pass (false: already done). */
  ran: boolean;
}

export interface ImageMigrationOptions {
  batchSize?: number;
  /** Tests: called after each row's files are written, before the row is updated. */
  afterBlobs?: (table: string, rowid: number) => void;
  force?: boolean;
}

export function migrateImagesPerChat(db: Db, blobs: BlobStore, { batchSize = 50, afterBlobs, force = false }: ImageMigrationOptions = {}): ImageMigrationResult {
  const result: ImageMigrationResult = { rows: {}, images: 0, missing: 0, skipped: 0, legacyDeleted: 0, ran: false };
  if (force || getMeta(db, IMAGES_PER_CHAT_KEY) !== "done") {
    result.ran = true;
    let shrunk = 0;
    for (const table of TABLES) {
      result.rows[table] = 0;
      const select = db.prepare(
        `SELECT rowid AS rid, session_id AS sid, payload_json AS json FROM ${table} WHERE rowid > ? AND ${OF_A_CHAT} AND (${INLINE} OR ${LEGACY}) ORDER BY rowid LIMIT ?`,
      );
      const update = db.prepare(`UPDATE ${table} SET payload_json = ? WHERE rowid = ? AND payload_json = ?`);
      let after = 0;
      for (;;) {
        const rows = select.all(after, batchSize) as Array<{ rid: number; sid: string; json: string | null }>;
        if (!rows.length) break;
        after = Number(rows.at(-1)!.rid);
        const changes: Array<{ rid: number; before: string; after: string }> = [];
        for (const row of rows) {
          if (typeof row.json !== "string") continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.json);
          } catch {
            continue;
          }
          const count = { n: 0, missing: 0 };
          let next: unknown;
          try {
            next = externalizeImages(parsed, blobs, String(row.sid), count);
          } catch {
            continue; // a session id that can't be a folder name: leave the row
          }
          result.missing += count.missing;
          if (next === parsed) continue;
          afterBlobs?.(table, Number(row.rid));
          result.images += count.n;
          changes.push({ rid: Number(row.rid), before: row.json, after: JSON.stringify(next) });
        }
        if (!changes.length) continue;
        transaction(db, () => {
          for (const c of changes) {
            const r = update.run(c.after, c.rid, c.before);
            if (Number(r.changes) > 0) {
              result.rows[table]!++;
              shrunk += c.before.length - c.after.length;
            } else result.skipped++;
          }
        });
      }
    }
    // Inline images moved out: worth giving the pages back once (see `vacuumIfAlone`).
    if (shrunk > 1_000_000) setMeta(db, "vacuum_pending", "1");
    if (result.skipped === 0) setMeta(db, IMAGES_PER_CHAT_KEY, "done");
  }
  if (getMeta(db, IMAGES_PER_CHAT_KEY) === "done" && blobs.hasLegacy()) {
    result.legacyDeleted = blobs.removeLegacy(legacyRefs(db)).deleted;
  }
  return result;
}

/** Legacy hashes rows still reference (after a completed pass: only ones whose file was missing). */
function legacyRefs(db: Db): Set<string> {
  const refs = new Set<string>();
  for (const table of TABLES) {
    for (const row of db.prepare(`SELECT payload_json AS json FROM ${table} WHERE ${OF_A_CHAT} AND ${LEGACY}`).iterate() as Iterable<{ json: string | null }>) {
      if (row.json) legacyBlobRefsIn(row.json, refs);
    }
  }
  return refs;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Move attachments from before I-163 (`<dataDir>/attachments/<sessionId>/…`) into the chats'
 * folders (`<dataDir>/chats/<sessionId>/files/…`), by rename (same volume). Folders of chats that
 * no longer exist are deleted (deleting a chat deleted them before, too). Idempotent: whatever a
 * crash left is moved on the next start; a name already taken at the target gets ` (2)` etc.
 */
export function moveAttachmentsIntoChats(dataDir: string, sessions: ReadonlySet<string>): { moved: number; removed: number } {
  const result = { moved: 0, removed: 0 };
  const legacy = join(dataDir, "attachments");
  let ids: string[];
  try {
    ids = readdirSync(legacy);
  } catch {
    return result;
  }
  for (const id of ids) {
    const from = join(legacy, id);
    try {
      if (!SESSION_ID.test(id) || !sessions.has(id)) {
        rmSync(from, { recursive: true, force: true });
        result.removed++;
        continue;
      }
      const to = join(dataDir, CHATS_DIR, id, "files");
      if (!existsSync(to)) {
        mkdirSync(join(dataDir, CHATS_DIR, id), { recursive: true });
        renameSync(from, to);
      } else {
        for (const name of readdirSync(from)) renameSync(join(from, name), freeName(to, name));
        rmdirSync(from);
      }
      result.moved++;
    } catch (err) {
      console.warn(`[glade] store: could not move the attached files of chat ${id}: ${(err as Error).message}`);
    }
  }
  try {
    if (readdirSync(legacy).length === 0) rmdirSync(legacy);
  } catch {
    /* gone, or not empty */
  }
  return result;
}

/** `dir/name`, or `dir/name (2).ext` etc. when taken. */
function freeName(dir: string, name: string): string {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  let path = join(dir, name);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${stem} (${n})${ext !== name ? ext : ""}`);
  return path;
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
