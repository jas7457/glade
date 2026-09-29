/**
 * Files attached by reference (I-090): saved in the chat's folder, `<dataDir>/chats/<sessionId>/
 * files/` (I-163; deleted with the chat), with a sanitized, unique name; the prompt then points
 * the agent at the absolute path (see `@glade/protocol` attachments.ts). Nothing is written
 * outside that folder: session ids and names are validated/sanitized, and the final path is
 * checked to be inside it. Uploads larger than the cap are aborted while streaming and the
 * partial file removed. Paths from before I-163 (`<dataDir>/attachments/<sessionId>/…`, moved by
 * `store/migrate-images.ts`) are mapped to their new place (`current`).
 */
import { mkdirSync } from "node:fs";
import { open, rm, stat, unlink } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { MAX_ATTACHMENT_BYTES, type AttachmentUploadResponse } from "@glade/protocol";

export class AttachmentError extends Error {
  constructor(
    readonly status: 400 | 404 | 413,
    message: string,
  ) {
    super(message);
  }
}

const MAX_NAME_LENGTH = 160;

/**
 * A safe file name: the last path segment only, no control or reserved characters, no leading
 * dots (hidden files, `..`), at most {@link MAX_NAME_LENGTH} characters (keeping the extension).
 */
export function sanitizeAttachmentName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  let name = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (name.length > MAX_NAME_LENGTH) {
    const ext = extname(name).slice(0, 20);
    name = name.slice(0, MAX_NAME_LENGTH - ext.length).trimEnd() + ext;
  }
  return name || "file";
}

/** `report.pdf` → `report (2).pdf`. */
function numbered(name: string, n: number): string {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${stem} (${n})${ext && ext !== name ? ext : ""}`;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface SaveAttachmentOptions {
  /** Size cap in bytes (default {@link MAX_ATTACHMENT_BYTES}). */
  maxBytes?: number;
}

/** A chat folder's subfolder for attached files. */
export const FILES_DIR = "files";

export class AttachmentStore {
  /** The chats folder (`<dataDir>/chats`); a session's files are in `<root>/<id>/files/`. */
  readonly root: string;
  /** Where attachments were before I-163 (`<dataDir>/attachments`), for old paths. */
  readonly legacyRoot: string | null;

  constructor(root: string, legacyRoot?: string) {
    this.root = resolve(root);
    this.legacyRoot = legacyRoot ? resolve(legacyRoot) : null;
  }

  /** The folder of one session's attachments (validated: never outside {@link root}). */
  dirFor(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new AttachmentError(400, "Invalid session id");
    const dir = resolve(this.root, sessionId, FILES_DIR);
    if (!this.isInside(join(dir, "x"))) throw new AttachmentError(400, "Invalid session id");
    return dir;
  }

  /** Whether `path` is inside some session's attachments folder (not the folder itself). */
  isInside(path: string): boolean {
    const abs = resolve(path);
    if (!abs.startsWith(this.root + sep)) return false;
    const parts = relative(this.root, abs).split(sep);
    return parts.length >= 3 && SESSION_ID.test(parts[0]!) && parts[1] === FILES_DIR && !parts.includes("..");
  }

  /** Where an attachment path is now: an old `<dataDir>/attachments/<id>/…` path is mapped. */
  current(path: string): string {
    if (!this.legacyRoot) return path;
    const abs = resolve(path);
    if (!abs.startsWith(this.legacyRoot + sep)) return path;
    const [sessionId, ...rest] = relative(this.legacyRoot, abs).split(sep);
    if (!sessionId || !SESSION_ID.test(sessionId) || !rest.length) return path;
    return join(this.root, sessionId, FILES_DIR, ...rest);
  }

  /** Whether `path` (or where an old path moved to) is an existing attachment file. */
  async isAttachment(path: string): Promise<boolean> {
    const now = this.current(path);
    if (!this.isInside(now)) return false;
    return stat(now).then(
      (s) => s.isFile(),
      () => false,
    );
  }

  /**
   * Save `body` as `name` (sanitized; ` (2)` etc. appended when taken) in the session's folder.
   * Throws {@link AttachmentError} 413 when it exceeds the cap (nothing is left behind).
   */
  async save(
    sessionId: string,
    name: string,
    body: ReadableStream<Uint8Array> | Uint8Array | null,
    options: SaveAttachmentOptions = {},
  ): Promise<AttachmentUploadResponse> {
    const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    const dir = this.dirFor(sessionId);
    mkdirSync(dir, { recursive: true });
    const clean = sanitizeAttachmentName(name);
    const { path, handle, finalName } = await this.createUnique(dir, clean);
    let size = 0;
    try {
      const write = async (chunk: Uint8Array) => {
        size += chunk.byteLength;
        if (size > maxBytes) throw tooLarge(maxBytes);
        await handle.write(chunk);
      };
      if (body instanceof Uint8Array) await write(body);
      else if (body) {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) await write(value);
          }
        } catch (err) {
          await reader.cancel().catch(() => {});
          throw err;
        }
      }
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw err;
    }
    return { path, name: finalName, size };
  }

  /** Remove a session's attachments (the session is deleted; the store removes its whole folder too). */
  async removeSession(sessionId: string): Promise<void> {
    let dir: string;
    try {
      dir = this.dirFor(sessionId);
    } catch {
      return;
    }
    await rm(dir, { recursive: true, force: true });
  }

  /** Create `name` exclusively in `dir`, numbering it when taken. */
  private async createUnique(dir: string, name: string) {
    for (let n = 1; n < 1000; n++) {
      const finalName = n === 1 ? name : numbered(name, n);
      const path = join(dir, finalName);
      if (!this.isInside(path)) throw new AttachmentError(400, "Invalid file name");
      try {
        const handle = await open(path, "wx");
        return { path, handle, finalName };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    throw new AttachmentError(400, "Too many files with that name");
  }
}

function tooLarge(maxBytes: number): AttachmentError {
  return new AttachmentError(413, `Files can be at most ${Math.round(maxBytes / (1024 * 1024))} MB`);
}
