/**
 * Pure helpers for `@` file mentions (I-044): find the mention being typed at the caret and
 * insert a picked file/folder.
 */
import type { FileEntry } from "@glade/protocol";

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

/** A piece of a sent message: plain text, or an `@path` mention (I-092). */
export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; /** As written, e.g. `@"my docs/a.md"`. */ raw: string; path: string; kind: "file" | "dir" };

const MENTION_TOKEN = /(^|\s)@(?:"([^"\n]+)"|([^\s"@]+))/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'`]+$/;

/**
 * Split a message into text and `@path` mentions as the `@` menu inserts them (`@a/b.ts`,
 * `@dir/`, `@"with spaces.md"`). `@` inside a word (emails) isn't a mention; an unquoted token
 * must look like a path (contain `/` or `.`), so `@everyone` stays text; trailing punctuation
 * (`@a.ts,`) isn't part of it. Joining the segments' text gives the message back.
 */
export function splitMentions(text: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  let last = 0;
  const pushText = (s: string) => {
    if (!s) return;
    const prev = out[out.length - 1];
    if (prev?.type === "text") prev.text += s;
    else out.push({ type: "text", text: s });
  };
  for (const m of text.matchAll(MENTION_TOKEN)) {
    const lead = m[1] ?? "";
    const start = m.index + lead.length;
    let raw: string;
    let path: string;
    if (m[2] !== undefined) {
      raw = `@"${m[2]}"`;
      path = m[2];
    } else {
      path = (m[3] ?? "").replace(TRAILING_PUNCTUATION, "");
      raw = `@${path}`;
      if (!/[/.]/.test(path) || path === "." || /^\.+$/.test(path)) continue;
    }
    if (!path.trim()) continue;
    pushText(text.slice(last, start));
    const kind = path.endsWith("/") ? "dir" : "file";
    out.push({ type: "mention", raw, path: kind === "dir" ? path.replace(/\/+$/, "") || "/" : path, kind });
    last = start + raw.length;
  }
  pushText(text.slice(last));
  return out;
}
