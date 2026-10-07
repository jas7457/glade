/**
 * Referencing an earlier message in the composer (I-203, a bookmark's "Reference"): the message
 * shows as a chip above the text and is sent as a short quote before it, so the agent knows
 * exactly which message the user means. References are kept per composer (`draftKey`, like
 * drafts: in memory, surviving chat switches) until sent or removed.
 *
 * What's sent (`withReferences`):
 *
 *   Re: your earlier reply (“Q3 numbers”, Sun 5 Oct, 14:32):
 *   > ## Q3 numbers
 *   > | Region | Revenue |
 *   > …
 *
 *   <the typed text>
 *
 * The quote is the message's first lines, cut to {@link QUOTE_MAX_LINES} lines /
 * {@link QUOTE_MAX_CHARS} characters, enough to identify it without re-sending it all.
 */
import { signal } from "@preact/signals";
import type { MessageAnchor } from "@glade/protocol";

export interface MessageReference {
  /** Tells references apart (the bookmark's id). */
  id: string;
  /** Shown on the chip and in the quote's header. */
  label: string;
  message: MessageAnchor;
  /** The message's text (Markdown). */
  text: string;
  /** A passage of the message (a selection bookmark), not all of it. */
  passage?: boolean;
}

export const QUOTE_MAX_LINES = 8;
export const QUOTE_MAX_CHARS = 600;

/** draftKey → references waiting to be sent with that composer's next message. */
export const composerReferences = signal<ReadonlyMap<string, readonly MessageReference[]>>(new Map());

/** The references of one composer. */
export function referencesOf(draftKey: string): readonly MessageReference[] {
  return composerReferences.value.get(draftKey) ?? [];
}

/** Set (or clear, with `[]`) a composer's references. */
export function setReferences(draftKey: string, refs: readonly MessageReference[]): void {
  const next = new Map(composerReferences.value);
  if (refs.length) next.set(draftKey, refs);
  else next.delete(draftKey);
  composerReferences.value = next;
}

/** Add a reference to session `chatId`'s composer (again: nothing changes). */
export function addReference(chatId: string, ref: MessageReference): void {
  const key = `chat:${chatId}`;
  const refs = referencesOf(key);
  if (refs.some((r) => r.id === ref.id)) return;
  setReferences(key, [...refs, ref]);
}

export function removeReference(draftKey: string, id: string): void {
  setReferences(
    draftKey,
    referencesOf(draftKey).filter((r) => r.id !== id),
  );
}

/** The start of a message as a Markdown quote (≤ QUOTE_MAX_LINES lines, ≤ QUOTE_MAX_CHARS chars). */
export function quoteLines(text: string): string {
  // Runs of blank lines count as one.
  const lines = text
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n")
    .filter((l, i, all) => l.trim() || (i > 0 && all[i - 1]!.trim()));
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length === QUOTE_MAX_LINES || chars >= QUOTE_MAX_CHARS) break;
    const room = QUOTE_MAX_CHARS - chars;
    kept.push(line.length > room ? `${line.slice(0, Math.max(0, room - 1)).trimEnd()}…` : line);
    chars += line.length + 1;
  }
  const cut = kept.length < lines.length;
  while (kept.length && !kept.at(-1)!.trim()) kept.pop();
  if (cut && !kept.at(-1)?.endsWith("…")) kept.push("…");
  return kept.map((l) => (l.trim() ? `> ${l}` : ">")).join("\n");
}

/** One reference as sent. `formatTime` is injectable for tests. */
export function referenceQuote(ref: MessageReference, formatTime: (ts: number) => string = defaultTime): string {
  const what = ref.message.role === "assistant" ? (ref.passage ? "a passage of your earlier reply" : "your earlier reply") : ref.passage ? "a passage of my earlier message" : "my earlier message";
  return `Re: ${what} (“${ref.label}”, ${formatTime(ref.message.timestamp)}):\n${quoteLines(ref.text)}`;
}

/** The text to send: the quotes of the references, then what was typed. */
export function withReferences(text: string, refs: readonly MessageReference[], formatTime?: (ts: number) => string): string {
  if (!refs.length) return text;
  const quotes = refs.map((r) => referenceQuote(r, formatTime)).join("\n\n");
  return text.trim() ? `${quotes}\n\n${text}` : quotes;
}

function defaultTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(ts);
}
