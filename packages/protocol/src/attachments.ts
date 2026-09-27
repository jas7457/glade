/**
 * Files attached by reference (I-090). Images go inline with the prompt; any other file is
 * uploaded to the server (`POST /api/sessions/:id/attachments?name=`, raw bytes), saved under
 * `<dataDir>/attachments/<sessionId>/`, and the prompt text gets one trailing line per file:
 *
 *   Attached file: /abs/path/report.pdf
 *
 * The agent reads the file with its own tools. The web shows those lines as file chips; these
 * helpers are the single definition of the line format for server and web.
 */

/** Largest file the server accepts as an attachment (50 MB). */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** `POST /api/sessions/:id/attachments?name=<file name>` (body: the file's bytes) → this. */
export interface AttachmentUploadResponse {
  /** Absolute path of the saved file. */
  path: string;
  /** Its (sanitized, unique) file name. */
  name: string;
  /** Size in bytes. */
  size: number;
}

export const ATTACHED_FILE_PREFIX = "Attached file: ";

/** `text` plus one `Attached file: <path>` line per path (after a blank line when there is text). */
export function formatAttachedFiles(text: string, paths: readonly string[]): string {
  if (paths.length === 0) return text;
  const lines = paths.map((p) => `${ATTACHED_FILE_PREFIX}${p}`).join("\n");
  return text.trim() ? `${text.replace(/\s+$/, "")}\n\n${lines}` : lines;
}

/**
 * Split the trailing `Attached file:` lines off a prompt: `{ text, files }` where `text` is what
 * the user typed and `files` the attached paths (in order). Only a trailing block of such lines
 * counts; the same words inside the message are left alone.
 */
export function parseAttachedFiles(text: string): { text: string; files: string[] } {
  const lines = text.replace(/\s+$/, "").split("\n");
  const files: string[] = [];
  while (lines.length > 0) {
    const line = lines[lines.length - 1]!;
    if (!line.startsWith(ATTACHED_FILE_PREFIX)) break;
    const path = line.slice(ATTACHED_FILE_PREFIX.length).trim();
    if (!path.startsWith("/")) break;
    files.unshift(path);
    lines.pop();
  }
  if (files.length === 0) return { text, files };
  return { text: lines.join("\n").replace(/\s+$/, ""), files };
}

/** The last path segment (`/a/b/report.pdf` → `report.pdf`). */
export function attachmentName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}
