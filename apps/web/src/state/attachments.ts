/**
 * Files attached by reference (I-090): upload them to the session's attachments folder on the
 * server and point the prompt at the saved paths (`Attached file: …` lines, see
 * `@glade/protocol` attachments.ts). Images don't come here; they go inline with the prompt.
 *
 * The upload goes to the environment the session lives on (I-123/I-125: its base URL and
 * device token), so the paths in the prompt are paths on the host that runs the agent.
 */
import { formatAttachedFiles, type AttachmentUploadResponse } from "@glade/protocol";
import type { ApiClient } from "@/lib/api";
import { apiForSession } from "./env-api";

/** Upload one file (raw bytes) for `sessionId` to its environment. */
export async function uploadAttachment(sessionId: string, file: File, client: ApiClient = apiForSession(sessionId)): Promise<AttachmentUploadResponse> {
  try {
    return await client.uploadAttachment(sessionId, file, file.name);
  } catch (err) {
    throw new Error(`${file.name}: ${(err as Error).message}`);
  }
}

/** Upload `files` (in order) and return `text` with one `Attached file:` line per saved file. */
export async function attachFilesToText(sessionId: string, text: string, files: readonly File[]): Promise<string> {
  if (files.length === 0) return text;
  const client = apiForSession(sessionId);
  const saved = await Promise.all(files.map((file) => uploadAttachment(sessionId, file, client)));
  return formatAttachedFiles(text, saved.map((s) => s.path));
}
