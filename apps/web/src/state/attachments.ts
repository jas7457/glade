/**
 * Files attached by reference (I-090): upload them to the session's attachments folder on the
 * server and point the prompt at the saved paths (`Attached file: …` lines, see
 * `@glade/protocol` attachments.ts). Images don't come here; they go inline with the prompt.
 */
import { formatAttachedFiles, type AttachmentUploadResponse } from "@glade/protocol";

/** Upload one file (raw bytes) for `sessionId`. */
export async function uploadAttachment(sessionId: string, file: File): Promise<AttachmentUploadResponse> {
  const res = await fetch(`/api/sessions/${sessionId}/attachments?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* not json */
    }
    throw new Error(`${file.name}: ${message}`);
  }
  return (await res.json()) as AttachmentUploadResponse;
}

/** Upload `files` (in order) and return `text` with one `Attached file:` line per saved file. */
export async function attachFilesToText(sessionId: string, text: string, files: readonly File[]): Promise<string> {
  if (files.length === 0) return text;
  const saved = await Promise.all(files.map((file) => uploadAttachment(sessionId, file)));
  return formatAttachedFiles(text, saved.map((s) => s.path));
}
