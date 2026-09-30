/**
 * What conversation mode reads aloud (I-180): markdown turned into speakable text (no symbols),
 * with code blocks, tables and images announced instead of read, links read by their text, and a
 * map from spoken offsets back to the markdown source, so the word being spoken (the engine's
 * `word` events are offsets into the spoken text) can be highlighted.
 *
 *   const s = toSpeakable("Run **`pnpm test`**, see [the docs](https://…).");
 *   s.text                         // "Run pnpm test, see the docs."
 *   sourceRange(s, 4, 8)           // [7, 11]: "pnpm" in the markdown
 *
 * `turnSpeech(transcript)` builds the reply of the latest turn: what the agent did ("I ran 3
 * commands.") and its final text.
 */
import type { AssistantMessage, ToolKind, Transcript } from "@glade/protocol";

/** A piece of spoken text and where it came from. */
export interface SpeechSegment {
  /** [start, end) in the spoken text. */
  start: number;
  end: number;
  /** [srcStart, srcEnd) in the markdown; null for words that aren't in it ("I ran 3 commands."). */
  src: [number, number] | null;
  /** Copied character for character from the source (offsets map 1:1 inside it). */
  verbatim: boolean;
  /** An announcement ("There's a code block on screen."), shown apart from the reply's words. */
  note: boolean;
}

export interface Speakable {
  text: string;
  segments: SpeechSegment[];
}

class Builder {
  text = "";
  segments: SpeechSegment[] = [];

  /** Text copied from source[srcStart…]; merges with the previous run when both are contiguous. */
  verbatim(chunk: string, srcStart: number): void {
    if (!chunk) return;
    const last = this.segments.at(-1);
    const start = this.text.length;
    this.text += chunk;
    if (last && last.verbatim && !last.note && last.end === start && last.src && last.src[1] === srcStart) {
      last.end = this.text.length;
      last.src[1] = srcStart + chunk.length;
      return;
    }
    this.segments.push({ start, end: this.text.length, src: [srcStart, srcStart + chunk.length], verbatim: true, note: false });
  }

  /** Words standing for a source range (a link's host, "an image"), or glue with no source. */
  replaced(chunk: string, src: [number, number] | null, note = false): void {
    if (!chunk) return;
    const start = this.text.length;
    this.text += chunk;
    this.segments.push({ start, end: this.text.length, src, verbatim: false, note });
  }

  /** Separator between blocks: ends the previous sentence so the voice pauses. */
  breakBlock(): void {
    const trimmed = this.text.trimEnd();
    if (!trimmed) return;
    if (trimmed.length < this.text.length) {
      // Drop trailing spaces from the text and the segments that end there.
      this.text = trimmed;
      for (const s of this.segments) {
        if (s.end > trimmed.length) {
          if (s.verbatim && s.src) s.src[1] -= s.end - trimmed.length;
          s.end = trimmed.length;
        }
      }
      this.segments = this.segments.filter((s) => s.end > s.start);
    }
    if (!/[.!?:;…]["')\]]?$/.test(this.text)) this.replaced(".", null);
    this.replaced("\n", null);
  }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(?:\s+|$)/;
const QUOTE = /^ {0,3}(?:>\s?)+/;
const LIST = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/;
const RULE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const TABLE = /^\s*\|/;

/** Markdown → speakable text with a source map. */
export function toSpeakable(markdown: string): Speakable {
  const b = new Builder();
  const lines: Array<{ text: string; start: number }> = [];
  let pos = 0;
  for (const text of markdown.split("\n")) {
    lines.push({ text, start: pos });
    pos += text.length + 1;
  }
  let inParagraph = false;
  for (let i = 0; i < lines.length; i++) {
    const { text, start } = lines[i]!;
    const fence = FENCE.exec(text);
    if (fence) {
      const marker = fence[1]!;
      let j = i + 1;
      while (j < lines.length && !lines[j]!.text.trimStart().startsWith(marker)) j++;
      const end = j < lines.length ? lines[j]!.start + lines[j]!.text.length : markdown.length;
      b.breakBlock();
      b.replaced("There's a code block on screen.", [start, end], true);
      b.breakBlock();
      inParagraph = false;
      i = j;
      continue;
    }
    if (TABLE.test(text)) {
      let j = i;
      while (j + 1 < lines.length && TABLE.test(lines[j + 1]!.text)) j++;
      b.breakBlock();
      b.replaced("There's a table on screen.", [start, lines[j]!.start + lines[j]!.text.length], true);
      b.breakBlock();
      inParagraph = false;
      i = j;
      continue;
    }
    if (!text.trim() || RULE.test(text)) {
      if (inParagraph) b.breakBlock();
      inParagraph = false;
      continue;
    }
    const block = HEADING.exec(text) ?? LIST.exec(text);
    if (block) {
      // Headings and list items are sentences of their own.
      if (inParagraph) b.breakBlock();
      inline(b, text.slice(block[0].length).replace(/\s+#+\s*$/, ""), start + block[0].length);
      b.breakBlock();
      inParagraph = false;
      continue;
    }
    const quote = QUOTE.exec(text);
    const from = quote ? quote[0].length : 0;
    if (inParagraph) b.replaced(" ", null);
    inline(b, text.slice(from).replace(/ {2,}$|\\$/, ""), start + from);
    inParagraph = true;
  }
  b.breakBlock();
  // No trailing newline.
  if (b.text.endsWith("\n")) {
    b.text = b.text.slice(0, -1);
    const last = b.segments.at(-1);
    if (last && last.end > b.text.length) b.segments.pop();
  }
  return { text: b.text, segments: b.segments };
}

const URL_RE = /^https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]]/;

/** Inline markdown of one line (`src` = the line's offset in the markdown). */
function inline(b: Builder, line: string, src: number): void {
  let run = "";
  let runStart = 0;
  const flush = () => {
    b.verbatim(run, src + runStart);
    run = "";
  };
  const copy = (i: number, ch: string) => {
    if (!run) runStart = i;
    else if (runStart + run.length !== i) {
      flush();
      runStart = i;
    }
    run += ch;
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    const rest = line.slice(i);
    // Escapes: `\*` → `*` as text (then usually dropped below as a symbol anyway).
    if (ch === "\\" && i + 1 < line.length && /[\\`*_{}[\]()#+\-.!|>~<]/.test(line[i + 1]!)) {
      i++;
      if (/[.!]/.test(line[i]!)) copy(i, line[i]!);
      i++;
      continue;
    }
    if (ch === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const close = line.indexOf(ticks, i + ticks.length);
      if (close > 0) {
        const inner = line.slice(i + ticks.length, close);
        const lead = inner.length - inner.trimStart().length;
        const body = inner.trim();
        for (let k = 0; k < body.length; k++) copy(i + ticks.length + lead + k, body[k]!);
        i = close + ticks.length;
        continue;
      }
    }
    // Images: announced.
    const image = /^!\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/.exec(rest);
    if (image) {
      flush();
      b.replaced(image[1]?.trim() ? `an image of ${image[1].trim()}` : "an image", [src + i, src + i + image[0].length]);
      i += image[0].length;
      continue;
    }
    // Links: their text (inline markdown inside), not the URL.
    const link = /^\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/.exec(rest) ?? /^\[([^\]]+)\]\[[^\]]*\]/.exec(rest);
    if (link) {
      flush();
      inline(b, link[1]!, src + i + 1);
      i += link[0].length;
      continue;
    }
    // Autolinks and bare URLs: "a link to example.com".
    const auto = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
    const bare = /\w/.test(line[i - 1] ?? "") ? null : URL_RE.exec(rest);
    const url = auto?.[1] ?? bare?.[0];
    if (url) {
      flush();
      const len = auto ? auto[0].length : url.length;
      b.replaced(`a link to ${hostOf(url)}`, [src + i, src + i + len]);
      i += len;
      continue;
    }
    // HTML tags: dropped (<br> reads as a pause).
    const tag = /^<\/?[a-zA-Z][^<>]*>/.exec(rest);
    if (tag) {
      flush();
      if (/^<br/i.test(tag[0])) b.replaced(", ", null);
      i += tag[0].length;
      continue;
    }
    // Emphasis and strikethrough markers.
    if (ch === "*" || ch === "~") {
      i += /^[*~]+/.exec(rest)![0].length;
      continue;
    }
    if (ch === "_") {
      const n = /^_+/.exec(rest)![0].length;
      const before = line[i - 1] ?? " ";
      const after = line[i + n] ?? " ";
      // snake_case stays as it is; only markers at a word's edge go.
      if (!(/\w/.test(before) && /\w/.test(after))) {
        i += n;
        continue;
      }
    }
    // Symbols that read badly.
    if (ch === "#" || ch === "|" || ch === ">" || ch === "<") {
      i++;
      continue;
    }
    copy(i, ch);
    i++;
  }
  flush();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "a website";
  }
}

/** The markdown range for a spoken range (e.g. the engine's current word), or null. */
export function sourceRange(s: Speakable, start: number, end: number): [number, number] | null {
  let from: number | null = null;
  let to: number | null = null;
  for (const seg of s.segments) {
    if (!seg.src || seg.end <= start || seg.start >= end) continue;
    const a = seg.verbatim ? seg.src[0] + (Math.max(start, seg.start) - seg.start) : seg.src[0];
    const z = seg.verbatim ? seg.src[0] + (Math.min(end, seg.end) - seg.start) : seg.src[1];
    from = from === null ? a : Math.min(from, a);
    to = to === null ? z : Math.max(to, z);
  }
  return from === null || to === null ? null : [from, to];
}

/** Joins speakables (each ends a sentence), e.g. "I ran 3 commands." + the reply. */
export function joinSpeakables(parts: Speakable[]): Speakable {
  const out: Speakable = { text: "", segments: [] };
  for (const p of parts) {
    if (!p.text) continue;
    if (out.text) {
      out.segments.push({ start: out.text.length, end: out.text.length + 1, src: null, verbatim: false, note: false });
      out.text += "\n";
    }
    const offset = out.text.length;
    out.text += p.text;
    for (const s of p.segments) out.segments.push({ ...s, start: s.start + offset, end: s.end + offset, src: s.src ? [s.src[0], s.src[1]] : null });
  }
  return out;
}

/** Plain words (a note or a question) as a speakable. */
export function plainSpeakable(text: string, note = false): Speakable {
  return { text, segments: text ? [{ start: 0, end: text.length, src: null, verbatim: false, note }] : [] };
}

/** One sentence about the tools a turn used: "I ran 3 commands and edited 2 files." */
export function toolSummary(kinds: ToolKind[]): string | null {
  if (kinds.length === 0) return null;
  const count = (ks: ToolKind[]) => kinds.filter((k) => ks.includes(k)).length;
  const n = (k: number, one: string, many: string) => `${k === 1 ? "one" : String(k)} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  const shell = count(["shell"]);
  const edits = count(["edit", "write"]);
  const reads = count(["read"]);
  const searches = count(["search", "list"]);
  const web = count(["web"]);
  const agents = count(["task", "agent"]);
  const other = kinds.length - shell - edits - reads - searches - web - agents;
  if (shell) parts.push(`ran ${n(shell, "command", "commands")}`);
  if (edits) parts.push(`made ${n(edits, "edit", "edits")}`);
  if (reads) parts.push(`read ${n(reads, "file", "files")}`);
  if (searches) parts.push(`searched ${searches === 1 ? "once" : `${searches} times`}`);
  if (web) parts.push(`looked something up on the web`);
  if (agents) parts.push(`worked with sub-agents`);
  if (other) parts.push(`used ${n(other, "tool", "tools")}`);
  const last = parts.pop()!;
  return `I ${parts.length ? `${parts.join(", ")} and ${last}` : last}.`;
}

/** The latest turn's reply, as spoken; null when there's nothing to say. */
export interface TurnSpeech extends Speakable {
  /** The assistant message the markdown offsets refer to. */
  messageId: string | null;
}

/**
 * The reply to the latest user message: what the agent did (tools, announced) and its final text
 * (the last assistant message with text). Errors and stops are said as such.
 */
export function turnSpeech(transcript: Transcript): TurnSpeech | null {
  const { messages } = transcript;
  let from = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      from = i + 1;
      break;
    }
  }
  const replies = messages.slice(from).filter((m): m is AssistantMessage => m.role === "assistant");
  if (replies.length === 0) return null;
  const kinds = replies.flatMap((m) => m.content.flatMap((b) => (b.type === "toolCall" ? [b.kind] : [])));
  const withText = [...replies].reverse().find((m) => m.content.some((b) => b.type === "text" && b.text.trim()));
  const last = replies.at(-1)!;
  const parts: Speakable[] = [];
  const summary = toolSummary(kinds);
  if (summary) parts.push(plainSpeakable(summary, true));
  if (withText) parts.push(toSpeakable(withText.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n\n")));
  if (last.stopReason === "error") parts.push(plainSpeakable(`Something went wrong${last.errorMessage ? `: ${last.errorMessage.replace(/\s+/g, " ").slice(0, 200)}` : "."}`, true));
  else if (last.stopReason === "aborted") parts.push(plainSpeakable("Stopped.", true));
  const joined = joinSpeakables(parts);
  if (!joined.text) return null;
  return { ...joined, messageId: withText?.id ?? null };
}
