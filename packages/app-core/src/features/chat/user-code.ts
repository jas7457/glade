/**
 * Code in the user's own messages (I-194): split the text into plain text, `inline code` spans
 * and ``` fenced blocks. Nothing else is Markdown here (no headings, lists, bold, links), so
 * pasted logs, globs and `#` comments stay as typed. Unclosed backticks/fences stay literal.
 */

export type UserTextSegment =
  | { type: "text"; text: string }
  | { type: "code"; code: string }
  | { type: "fence"; code: string; language: string };

/** A fence: an opening line of 3+ backticks (optional language), the body, the same fence on its own line. */
const FENCE = /^(`{3,})[ \t]*([^\s`]*)[^\n`]*\n([\s\S]*?)\n?^\1[ \t]*$/gm;
/** Inline code: single backticks on one line, not empty. */
const INLINE = /`([^`\n]+)`/g;

export function splitUserCode(text: string): UserTextSegment[] {
  const out: UserTextSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    const start = m.index!;
    // The line breaks around a block are the block's own (it's a block element).
    pushInline(out, text.slice(last, start).replace(/\n$/, ""));
    out.push({ type: "fence", code: m[3] ?? "", language: m[2] ?? "" });
    last = start + m[0].length;
    if (text[last] === "\n") last++;
  }
  pushInline(out, text.slice(last));
  return out;
}

function pushInline(out: UserTextSegment[], text: string) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push({ type: "text", text: text.slice(last, m.index) });
    out.push({ type: "code", code: m[1]! });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
}
