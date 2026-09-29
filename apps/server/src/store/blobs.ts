/**
 * Every chat has one folder for its files (I-163), deleted as a whole with the chat:
 *
 *   <dataDir>/chats/<sessionId>/images/<name>.<ext>   images, referenced as `blob: "<sessionId>/<name>"`
 *   <dataDir>/chats/<sessionId>/files/…               attached files (`services/attachments.ts`)
 *
 * - **Per chat, no sharing:** a picture in two chats is two files. Deleting a chat deletes its
 *   folder (`removeChat`, called by the store right after the chat's rows are gone); there is no
 *   reference counting and no GC.
 * - **Atomic:** a file is written to a temp file in its folder and renamed into place, so readers
 *   never see a partial file; two servers on one data folder (I-062) writing the same image both
 *   succeed.
 * - **Stable names:** `<name>` is a short prefix of the bytes' SHA-256, so saving the same image
 *   again in the same chat (a streamed message repeated per update, a transcript re-imported)
 *   finds the file instead of writing another one.
 * - **Legacy:** I-157's shared content-addressed files (`<dataDir>/blobs/<aa>/<sha256>.<ext>`,
 *   refs `sha256:…`) are still read until `migrate-images.ts` has copied them into the chats'
 *   folders, then removed with `removeLegacy`.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chatBlobRef, parseBlobRef } from "@glade/protocol";

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

/** Hex characters of the SHA-256 used as a file name (64 bits: unique within one chat). */
const NAME_LENGTH = 16;

const LEGACY_FOLDER = /^[0-9a-f]{2}$/;

/** `<dataDir>/chats`: one folder per chat (I-163). */
export const CHATS_DIR = "chats";
/** A chat folder's subfolder for images. */
export const IMAGES_DIR = "images";
/** `<dataDir>/blobs`: I-157's shared content-addressed files (legacy). */
export const LEGACY_BLOBS_DIR = "blobs";

export interface BlobInfo {
  /** `<sessionId>/<name>`, or a legacy `sha256:<hex>`. */
  ref: string;
  path: string;
  mimeType: string;
  size: number;
}

export function extensionFor(mimeType: string): string {
  return EXT_BY_MIME[mimeType.toLowerCase()] ?? "bin";
}

export class BlobStore {
  /**
   * @param dir the chats folder (`<dataDir>/chats`)
   * @param legacyDir I-157's shared files (`<dataDir>/blobs`)
   */
  constructor(
    readonly dir: string,
    readonly legacyDir: string = join(dir, "..", LEGACY_BLOBS_DIR),
  ) {}

  /** Store `bytes` in chat `sessionId`'s folder; returns its reference. Writes nothing if it's there. */
  put(sessionId: string, bytes: Uint8Array, mimeType: string): BlobInfo {
    const chat = this.chatFolder(sessionId);
    if (!chat) throw new Error(`Not a valid chat id for an image folder: ${sessionId}`);
    const folder = join(chat, IMAGES_DIR);
    const name = createHash("sha256").update(bytes).digest("hex").slice(0, NAME_LENGTH);
    const path = join(folder, `${name}.${extensionFor(mimeType)}`);
    const ref = chatBlobRef(sessionId, name);
    if (existsSync(path)) return this.info(ref, path, bytes.length);
    mkdirSync(folder, { recursive: true });
    const tmp = join(folder, `.${name}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return this.info(ref, path, bytes.length);
  }

  /** Store base64 image data (as in an inline `ImageBlock`). */
  putBase64(sessionId: string, data: string, mimeType: string): BlobInfo {
    return this.put(sessionId, Buffer.from(data, "base64"), mimeType);
  }

  /** Where a referenced file is, or null when it doesn't exist (or the ref is malformed). */
  find(ref: string): BlobInfo | null {
    const parsed = parseBlobRef(ref);
    if (!parsed) return null;
    const folder = parsed.kind === "chat" ? join(this.dir, parsed.sessionId, IMAGES_DIR) : join(this.legacyDir, parsed.hash.slice(0, 2));
    const stem = parsed.kind === "chat" ? parsed.name : parsed.hash;
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return null;
    }
    const name = names.find((n) => n.startsWith(`${stem}.`) && !n.endsWith(".tmp"));
    if (!name) return null;
    const path = join(folder, name);
    try {
      return this.info(ref, path, statSync(path).size);
    } catch {
      return null;
    }
  }

  /** The file's bytes, or null when it's missing. */
  read(ref: string): Buffer | null {
    const found = this.find(ref);
    if (!found) return null;
    try {
      return readFileSync(found.path);
    } catch {
      return null;
    }
  }

  /** Delete a chat's whole folder, images and attached files (the chat was deleted). */
  removeChat(sessionId: string): void {
    const folder = this.chatFolder(sessionId);
    if (!folder) return;
    try {
      rmSync(folder, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[glade] could not delete the folder of chat ${sessionId}: ${(err as Error).message}`);
    }
  }

  /** Whether any legacy (I-157) content-addressed folder is left. */
  hasLegacy(): boolean {
    try {
      return readdirSync(this.legacyDir).some((f) => LEGACY_FOLDER.test(f));
    } catch {
      return false;
    }
  }

  /**
   * Delete legacy content-addressed files whose hash isn't in `keep` (and their emptied folders,
   * and the legacy folder itself once empty). Safe to run on several servers at once.
   */
  removeLegacy(keep: ReadonlySet<string>): { deleted: number; bytesFreed: number } {
    const result = { deleted: 0, bytesFreed: 0 };
    let folders: string[];
    try {
      folders = readdirSync(this.legacyDir);
    } catch {
      return result;
    }
    for (const f of folders) {
      if (!LEGACY_FOLDER.test(f)) continue;
      const folder = join(this.legacyDir, f);
      let names: string[];
      try {
        names = readdirSync(folder);
      } catch {
        continue;
      }
      let left = names.length;
      for (const name of names) {
        if (!name.endsWith(".tmp") && keep.has(name.split(".")[0]!)) continue;
        const path = join(folder, name);
        try {
          const size = statSync(path).size;
          rmSync(path, { force: true });
          left--;
          if (!name.endsWith(".tmp")) {
            result.deleted++;
            result.bytesFreed += size;
          }
        } catch {
          /* another server got it */
        }
      }
      if (left === 0) {
        try {
          rmdirSync(folder);
        } catch {
          /* not empty (a late write) or gone */
        }
      }
    }
    try {
      if (readdirSync(this.legacyDir).length === 0) rmdirSync(this.legacyDir);
    } catch {
      /* gone, or something else lives there */
    }
    return result;
  }

  private chatFolder(sessionId: string): string | null {
    const parsed = parseBlobRef(chatBlobRef(sessionId, "x"));
    return parsed?.kind === "chat" ? join(this.dir, parsed.sessionId) : null;
  }

  private info(ref: string, path: string, size: number): BlobInfo {
    const ext = path.slice(path.lastIndexOf(".") + 1);
    return { ref, path, mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream", size };
  }
}
