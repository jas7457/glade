/**
 * Reading a reply while it streams (I-183), pure: `planTurn(transcript, ended)` looks at the
 * latest turn (everything after the last user message) and returns the pieces that are final, in
 * order, plus the text still being written (`tail`, shown but not read yet).
 *
 *   text → sentences of the speakable text (speakable.ts): a sentence is final once the stream
 *          has moved past it (more text after it, a new block, a blank line, a finished heading
 *          or list item) or the message / turn ended; half sentences are never read;
 *   code blocks and tables → their announcement, final as soon as the block opens;
 *   tool calls → one announcement per run of calls between texts ("Running a command.");
 *   a failed or stopped turn → "Something went wrong…" / "Stopped." at the end.
 *
 * Every piece has a stable `key` (message, block, where it starts in the markdown), so a caller
 * that keeps the keys it has read can take the new pieces of each snapshot (`newPieces`), even
 * when earlier text is re-rendered slightly differently as the stream grows.
 */
import type { AssistantMessage, ToolKind, Transcript } from "@glade/protocol";
import { plainSpeakable, sourceRange, toSpeakable, type Speakable } from "./speakable";

export interface ReplyPiece {
  key: string;
  /** What goes between the previous piece and this one: " " inside a paragraph, "\n" between blocks. */
  sep: string;
  speech: Speakable;
}

export interface TurnPlan {
  /** The turn: its user message's id ("" when there is none). */
  turn: string;
  /** The final pieces, in order. */
  pieces: ReplyPiece[];
  /** Text still being written after the last final piece (shown, not read yet). */
  tail: ReplyPiece | null;
}

/** The latest turn's final pieces. `ended`: the turn is over (everything left is final). */
export function planTurn(transcript: Transcript, ended: boolean): TurnPlan {
  const { messages } = transcript;
  let from = 0;
  let turn = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") {
      from = i + 1;
      turn = m.id;
      break;
    }
  }
  const replies = messages.slice(from).filter((m): m is AssistantMessage => m.role === "assistant");
  const pieces: ReplyPiece[] = [];
  let tail: ReplyPiece | null = null;
  let inToolRun = false;
  replies.forEach((m, mi) => {
    const lastMessage = mi === replies.length - 1;
    m.content.forEach((block, bi) => {
      if (block.type === "toolCall") {
        if (!inToolRun) pieces.push({ key: `${m.id}:${bi}:tool`, sep: "\n", speech: plainSpeakable(toolAnnouncement(block.kind), true) });
        inToolRun = true;
        return;
      }
      if (block.type !== "text" || !block.text.trim()) return;
      inToolRun = false;
      const blockEnded = ended || !m.streaming || !lastMessage || bi < m.content.length - 1;
      const text = textPieces(block.text, blockEnded, `${m.id}:${bi}`);
      pieces.push(...text.pieces);
      if (text.tail) tail = text.tail;
    });
  });
  const last = replies.at(-1);
  if (ended && last) {
    const end =
      last.stopReason === "error"
        ? `Something went wrong${last.errorMessage ? `: ${last.errorMessage.replace(/\s+/g, " ").slice(0, 200)}` : "."}`
        : last.stopReason === "aborted"
          ? "Stopped."
          : null;
    if (end) pieces.push({ key: `${last.id}:end`, sep: "\n", speech: plainSpeakable(end, true) });
  }
  return { turn, pieces, tail };
}

/** The pieces of `plan` not read yet: those after the last piece in `keys` (by key). */
export function newPieces(keys: readonly string[], pieces: readonly ReplyPiece[]): ReplyPiece[] {
  if (keys.length === 0) return [...pieces];
  const known = new Set(keys);
  let after = -1;
  for (let i = pieces.length - 1; i >= 0; i--) {
    if (known.has(pieces[i]!.key)) {
      after = i;
      break;
    }
  }
  return pieces.slice(after + 1).filter((p) => !known.has(p.key));
}

/** "Running a command." — said when a run of tool calls starts. */
export function toolAnnouncement(kind: ToolKind): string {
  switch (kind) {
    case "shell":
      return "Running a command.";
    case "read":
      return "Reading a file.";
    case "write":
      return "Writing a file.";
    case "edit":
      return "Editing a file.";
    case "search":
    case "list":
      return "Looking through the files.";
    case "web":
      return "Looking something up on the web.";
    case "task":
    case "agent":
      return "Working with a sub-agent.";
    case "chat":
      return "Looking at your other chats.";
    default:
      return "Using a tool.";
  }
}

// ---------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------

/** Words ending in a period that don't end a sentence ("e.g." and "U.S." are caught by shape). */
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "vs", "cf", "approx", "incl", "fig", "al", "st", "jr", "sr"]);

/**
 * Sentence ranges of speakable text: [start, end) with the end punctuation, without surrounding
 * whitespace. A line break always ends one (speakable text puts blocks on lines of their own).
 */
export function splitSentences(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  const end = (at: number) => {
    if (start < 0) return;
    let z = at;
    while (z > start && /\s/.test(text[z - 1]!)) z--;
    if (z > start) out.push([start, z]);
    start = -1;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      end(i);
      continue;
    }
    if (start < 0) {
      if (/\s/.test(ch)) continue;
      start = i;
    }
    if (!/[.!?…]/.test(ch)) continue;
    // The punctuation run and closing quotes/brackets.
    let j = i;
    while (j + 1 < text.length && /[.!?…]/.test(text[j + 1]!)) j++;
    while (j + 1 < text.length && /["'”’)\]]/.test(text[j + 1]!)) j++;
    const after = text[j + 1];
    if (after === undefined || !/[ \t]/.test(after)) {
      i = j;
      continue;
    }
    let k = j + 1;
    while (k < text.length && /[ \t]/.test(text[k]!)) k++;
    const next = text[k];
    // Nothing after it yet, or a new line: the line break (or the caller) decides.
    if (next === undefined || next === "\n") {
      i = j;
      continue;
    }
    if (/\p{Ll}/u.test(next) || (ch === "." && isAbbreviation(text, start, i))) {
      i = j;
      continue;
    }
    end(j + 1);
    i = j;
  }
  end(text.length);
  return out;
}

/** Whether the word before the period at `dot` is an abbreviation or an initial ("e.g", "J"). */
function isAbbreviation(text: string, from: number, dot: number): boolean {
  let a = dot;
  while (a > from && /[\p{L}\p{N}.]/u.test(text[a - 1]!)) a--;
  const word = text.slice(a, dot);
  if (!word) return false;
  if (/^(?:\p{L}\.)*\p{L}$/u.test(word)) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}

/** Whether the markdown so far ends a block for sure: a blank line, or a finished heading / list item. */
function endsBlock(markdown: string): boolean {
  if (/\n[ \t]*\n\s*$/.test(markdown)) return true;
  if (!markdown.endsWith("\n")) return false;
  const lines = markdown.split("\n");
  const last = lines[lines.length - 2] ?? "";
  return /^ {0,3}#{1,6}\s+\S/.test(last) || /^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/.test(last);
}

/** One text block's final sentences (and the rest as the tail). */
function textPieces(markdown: string, ended: boolean, keyBase: string): { pieces: ReplyPiece[]; tail: ReplyPiece | null } {
  const s = toSpeakable(markdown);
  const sentences = splitSentences(s.text);
  const pieces: ReplyPiece[] = [];
  let prevEnd = -1;
  let tail: ReplyPiece | null = null;
  sentences.forEach(([a, z], i) => {
    const last = i === sentences.length - 1;
    const final = ended || !last || isNote(s, a, z) || endsBlock(markdown);
    const sep = prevEnd < 0 ? "\n" : s.text.slice(prevEnd, a).includes("\n") ? "\n" : " ";
    const piece = { key: `${keyBase}:${sentenceKey(s, a)}`, sep, speech: sliceSpeakable(s, a, z) };
    if (final) {
      pieces.push(piece);
      prevEnd = z;
    } else {
      // Without the period speakable text adds at the end: the sentence isn't over.
      const glue = s.segments.find((seg) => seg.start === z - 1 && seg.end === z && !seg.src && s.text[z - 1] === ".");
      tail = { ...piece, key: `${keyBase}:tail`, speech: glue ? sliceSpeakable(s, a, z - 1) : piece.speech };
    }
  });
  return { pieces, tail };
}

function isNote(s: Speakable, a: number, z: number): boolean {
  const overlapping = s.segments.filter((seg) => seg.end > a && seg.start < z);
  return overlapping.length > 0 && overlapping.every((seg) => seg.note);
}

/** Where a sentence starts in the markdown (stable while the text grows), else in the speech. */
function sentenceKey(s: Speakable, a: number): string {
  const src = sourceRange(s, a, a + 1);
  return src ? String(src[0]) : `@${a}`;
}

/** The part [a, z) of a speakable, its source map kept. */
export function sliceSpeakable(s: Speakable, a: number, z: number): Speakable {
  const segments = s.segments
    .filter((seg) => seg.end > a && seg.start < z)
    .map((seg) => {
      const start = Math.max(seg.start, a);
      const end = Math.min(seg.end, z);
      const src: [number, number] | null = seg.src
        ? seg.verbatim
          ? [seg.src[0] + (start - seg.start), seg.src[0] + (end - seg.start)]
          : [seg.src[0], seg.src[1]]
        : null;
      return { ...seg, start: start - a, end: end - a, src };
    });
  return { text: s.text.slice(a, z), segments };
}

/** `a` + `sep` + `b` (the separator has no source). */
export function appendSpeakable(a: Speakable, sep: string, b: Speakable): Speakable {
  if (!a.text) return { text: b.text, segments: b.segments.map((seg) => ({ ...seg })) };
  const segments = a.segments.map((seg) => ({ ...seg }));
  let text = a.text;
  if (sep) {
    segments.push({ start: text.length, end: text.length + sep.length, src: null, verbatim: false, note: false });
    text += sep;
  }
  const offset = text.length;
  for (const seg of b.segments) segments.push({ ...seg, start: seg.start + offset, end: seg.end + offset });
  return { text: text + b.text, segments };
}
