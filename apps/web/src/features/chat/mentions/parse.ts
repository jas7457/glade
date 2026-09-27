/**
 * Pure helpers for `@` file mentions (I-044): find the mention being typed at the caret and
 * insert a picked file/folder.
 */
import type { FileEntry } from "@pi-ui/protocol";

export interface ActiveMention {
  /** Index of the `@`. */
  start: number;
  /** End of the token (the caret). */
  end: number;
  /** Text after the `@` (no whitespace). */
  query: string;
}

/** The `@query` token ending at `caret`, when the `@` is at the start or after whitespace. */
export function findMention(text: string, caret: number): ActiveMention | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@"]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, end: caret, query };
}

/** `@path` (quoted when it contains whitespace); folders end with `/`. */
export function mentionText(entry: FileEntry): string {
  const path = entry.kind === "dir" ? `${entry.path}/` : entry.path;
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/**
 * Replace the active mention with `entry`. Files get a trailing space (done); folders don't,
 * so the menu stays open to pick something inside (stepwise completion).
 */
export function applyMention(text: string, mention: ActiveMention, entry: FileEntry): { text: string; caret: number } {
  const quotedDir = entry.kind === "dir" && /\s/.test(entry.path);
  const insert = mentionText(entry) + (entry.kind === "file" || quotedDir ? " " : "");
  const rest = text.slice(mention.end);
  const joined = text.slice(0, mention.start) + insert + (insert.endsWith(" ") && rest.startsWith(" ") ? rest.slice(1) : rest);
  return { text: joined, caret: mention.start + insert.length };
}
