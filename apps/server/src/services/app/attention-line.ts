/**
 * The short line a system notification shows for a session (I-135): the open question while it
 * waits for input, the error when its last run failed, else the last sentence of the last reply.
 * Sent as `SessionSummary.attentionLine` so clients can notify for chats whose transcript they
 * haven't loaded (remote environments included).
 */
import { messageText, type ChatMessage, type Transcript, type UiRequest } from "@glade/protocol";

/** Longest line sent (notification banners show ~2 lines anyway). */
export const ATTENTION_LINE_MAX = 160;

export function attentionLine(transcript: Transcript | null, pending: Iterable<UiRequest>, failed: boolean): string | undefined {
  for (const request of pending) {
    const text = [request.title, "message" in request ? request.message : undefined].filter(Boolean).join(": ");
    if (text.trim()) return clip(text);
  }
  if (!transcript) return undefined;
  const last = lastOf(transcript.messages, (m) => m.role === "assistant" || (m.role === "notice" && m.kind === "error"));
  if (!last) return undefined;
  if (last.role === "assistant" && (last.stopReason === "error" || failed) && last.errorMessage) return clip(last.errorMessage);
  if (last.role === "notice") return failed ? clip(last.text) : undefined;
  return lastSentence(messageText(last));
}

/** The last sentence of a reply, without markdown decoration. */
export function lastSentence(text: string): string | undefined {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[\s>*#-]+/gm, "")
    .replace(/[*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  const sentences = plain.match(/[^.!?]+[.!?]*(?=\s|$)/g) ?? [plain];
  const sentence = sentences.map((s) => s.trim()).filter((s) => s.length > 1).pop() ?? plain;
  return clip(sentence);
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > ATTENTION_LINE_MAX ? `${line.slice(0, ATTENTION_LINE_MAX - 1).trimEnd()}…` : line;
}

function lastOf(messages: ChatMessage[], match: (m: ChatMessage) => boolean): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (match(messages[i]!)) return messages[i];
  return undefined;
}
