/**
 * Content-addressed files for images (I-157): `<dataDir>/blobs/<hash[0:2]>/<sha256>.<ext>`.
 *
 * - **Atomic and idempotent:** a blob is written to a unique temp file in its folder and renamed
 *   into place, so readers never see a partial file, and two servers on one data folder (I-062)
 *   writing the same image both succeed (same bytes, same name).
 * - **Deduplicated:** the name is the SHA-256 of the bytes; a second put finds the file and only
 *   touches its mtime (which protects it from a GC running on another server right now).
 * - **GC:** `gc(referenced)` deletes blobs no row references any more, but only once they're older
 *   than a grace period (a blob is written before the row that references it is committed).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BLOB_REF_PREFIX, blobHash } from "@glade/protocol";

/** File extension per image type (anything else is stored as `.bin`). */
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/tiff": "tiff",
};
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_BY_MIME)
    .filter(([m]) => m !== "image/jpg")
    .map(([m, e]) => [e, m]),
);
MIME_BY_EXT.bin = "application/octet-stream";

/** Unreferenced blobs younger than this are kept (their row may not be committed yet). */
export const BLOB_GC_GRACE_MS = 60 * 60_000;

export interface BlobInfo {
  /** `sha256:<hex>` */
  ref: string;
  hash: string;
  path: string;
  mimeType: string;
  size: number;
}

export interface BlobGcResult {
  scanned: number;
  deleted: number;
  /** Unreferenced but still inside the grace period. */
  kept: number;
  bytesFreed: number;
}

export function extensionFor(mimeType: string): string {
  return EXT_BY_MIME[mimeType.toLowerCase()] ?? "bin";
}

export class BlobStore {
  constructor(readonly dir: string) {}

  /** Store `bytes`; returns its reference. Writes nothing when the blob exists already. */
  put(bytes: Uint8Array, mimeType: string): BlobInfo {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const folder = join(this.dir, hash.slice(0, 2));
    const path = join(folder, `${hash}.${extensionFor(mimeType)}`);
    if (existsSync(path)) {
      // Fresh again: a GC elsewhere that saw it unreferenced must not delete it under our new row.
      const now = new Date();
      try {
        utimesSync(path, now, now);
      } catch {
        /* removed meanwhile: rewritten below */
      }
      if (existsSync(path)) return this.info(hash, path, bytes.length);
    }
    mkdirSync(folder, { recursive: true });
    const tmp = join(folder, `.${hash}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return this.info(hash, path, bytes.length);
  }

  /** Store base64 image data (as in an inline `ImageBlock`). */
  putBase64(data: string, mimeType: string): BlobInfo {
    return this.put(Buffer.from(data, "base64"), mimeType);
  }

  /** Where a blob is (by `sha256:<hex>` or bare hex), or null when it doesn't exist. */
  find(ref: string): BlobInfo | null {
    const hash = blobHash(ref);
    if (!hash) return null;
    const folder = join(this.dir, hash.slice(0, 2));
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return null;
    }
    const name = names.find((n) => n.startsWith(`${hash}.`) && !n.endsWith(".tmp"));
    if (!name) return null;
    const path = join(folder, name);
    try {
      return this.info(hash, path, statSync(path).size);
    } catch {
      return null;
    }
  }

  /** The blob's bytes, or null when it's missing. */
  read(ref: string): Buffer | null {
    const found = this.find(ref);
    if (!found) return null;
    try {
      return readFileSync(found.path);
    } catch {
      return null;
    }
  }

  /**
   * Delete blobs whose hash isn't in `referenced` and that are older than `graceMs` (by mtime).
   * Leftover temp files older than the grace period go too. Safe to run on several servers at once.
   */
  gc(referenced: ReadonlySet<string>, { graceMs = BLOB_GC_GRACE_MS, now = Date.now() }: { graceMs?: number; now?: number } = {}): BlobGcResult {
    const result: BlobGcResult = { scanned: 0, deleted: 0, kept: 0, bytesFreed: 0 };
    let folders: string[];
    try {
      folders = readdirSync(this.dir);
    } catch {
      return result;
    }
    for (const f of folders) {
      if (!/^[0-9a-f]{2}$/.test(f)) continue;
      const folder = join(this.dir, f);
      let names: string[];
      try {
        names = readdirSync(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(folder, name);
        const tmp = name.endsWith(".tmp");
        const hash = tmp ? null : name.split(".")[0]!;
        if (!tmp) result.scanned++;
        if (hash && referenced.has(hash)) continue;
        let stat;
        try {
          stat = statSync(path);
        } catch {
          continue;
        }
        if (graceMs > 0 && now - stat.mtimeMs < graceMs) {
          if (!tmp) result.kept++;
          continue;
        }
        try {
          rmSync(path, { force: true });
          if (!tmp) {
            result.deleted++;
            result.bytesFreed += stat.size;
          }
        } catch {
          /* another server got it */
        }
      }
    }
    return result;
  }

  private info(hash: string, path: string, size: number): BlobInfo {
    const ext = path.slice(path.lastIndexOf(".") + 1);
    return { ref: `${BLOB_REF_PREFIX}${hash}`, hash, path, mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream", size };
  }
}
