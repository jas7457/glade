/**
 * In-memory BM25 index over chat sessions (I-045). Pure (no I/O), so ranking is unit-testable.
 *
 * Each session is a set of fields (title, summary, one per user/assistant message). A field is
 * scored with BM25 (per-kind average length) times a kind weight; a session scores its best field
 * plus a damped bonus for the others, so one strongly matching message beats many weak ones.
 *
 * Query words match whole tokens (weight 1) or token prefixes (weight 0.6: "butt" → "button",
 * "button" → "buttons"). `all` mode (search box) requires every word somewhere in the session;
 * `any` mode (candidate retrieval for the chat finder) ranks sessions matching any word. Common
 * English stop words are dropped from the query unless nothing else is left.
 */
import type { HighlightedText } from "@pi-ui/protocol";

export type FieldKind = "title" | "summary" | "user" | "assistant";

export interface FieldInput {
  kind: FieldKind;
  text: string;
}

interface Field {
  kind: FieldKind;
  text: string;
  tf: Map<string, number>;
  len: number;
}

export interface IndexHit {
  sessionId: string;
  score: number;
  /** The best matching field (for the snippet). */
  kind: FieldKind;
  snippet: HighlightedText;
}

export interface SearchOptions {
  mode?: "all" | "any";
  limit?: number;
}

const WEIGHT: Record<FieldKind, number> = { title: 3, summary: 2, user: 1.3, assistant: 1 };
const K1 = 1.2;
const B = 0.75;
const PREFIX_WEIGHT = 0.6;
const MAX_PREFIX_EXPANSIONS = 40;
const SNIPPET_LENGTH = 160;

// prettier-ignore
const STOP_WORDS = new Set(("a an and are as at be but by can chat chats conversation could did do does for from had has have he her his how i if in into is it its me my of on one open or our please show so some that the their them then there these they this to up us was we were what when where which who why will with would you your about talked talking discussed session find").split(" "));

const TOKEN = /[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(TOKEN)) {
    const t = m[0];
    if (t.length >= 2 || /\d/.test(t)) out.push(t);
  }
  return out;
}

/** Distinct query terms, without stop words unless the query has nothing else. */
export function queryTerms(query: string): string[] {
  const all = [...new Set(tokenize(query))];
  const content = all.filter((t) => !STOP_WORDS.has(t));
  return content.length ? content : all;
}

function makeField({ kind, text }: FieldInput): Field {
  const tf = new Map<string, number>();
  const tokens = tokenize(text);
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { kind, text, tf, len: tokens.length };
}

export class TextIndex {
  private readonly sessions = new Map<string, Field[]>();
  /** term -> number of fields containing it. */
  private readonly df = new Map<string, number>();
  private fieldCount = 0;
  private readonly kindLen: Record<FieldKind, { total: number; count: number }> = {
    title: { total: 0, count: 0 },
    summary: { total: 0, count: 0 },
    user: { total: 0, count: 0 },
    assistant: { total: 0, count: 0 },
  };

  get size(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Add or replace a session's fields. Empty texts are skipped. */
  set(sessionId: string, inputs: readonly FieldInput[]): void {
    this.remove(sessionId);
    const fields = inputs.filter((f) => f.text.trim()).map(makeField);
    for (const f of fields) this.account(f, 1);
    this.sessions.set(sessionId, fields);
  }

  remove(sessionId: string): void {
    const fields = this.sessions.get(sessionId);
    if (!fields) return;
    for (const f of fields) this.account(f, -1);
    this.sessions.delete(sessionId);
  }

  private account(field: Field, sign: 1 | -1): void {
    this.fieldCount += sign;
    const k = this.kindLen[field.kind];
    k.total += sign * field.len;
    k.count += sign;
    for (const term of field.tf.keys()) {
      const n = (this.df.get(term) ?? 0) + sign;
      if (n <= 0) this.df.delete(term);
      else this.df.set(term, n);
    }
  }

  /** Index terms a query word matches: itself (weight 1) and longer terms it prefixes. */
  private expand(word: string): Array<[term: string, weight: number]> {
    const out: Array<[string, number]> = [];
    if (this.df.has(word)) out.push([word, 1]);
    if (word.length >= 2) {
      for (const term of this.df.keys()) {
        if (term.length > word.length && term.startsWith(word)) {
          out.push([term, PREFIX_WEIGHT]);
          if (out.length > MAX_PREFIX_EXPANSIONS) break;
        }
      }
    }
    return out;
  }

  search(query: string, { mode = "all", limit = 20 }: SearchOptions = {}): IndexHit[] {
    const words = queryTerms(query);
    if (!words.length || !this.fieldCount) return [];
    const expanded = words.map((w) => this.expand(w).map(([term, weight]) => ({ term, weight, idf: this.idf(term) })));
    if (mode === "all" && expanded.some((e) => e.length === 0)) return [];
    const phrase = words.length > 1 ? query.trim().toLowerCase().replace(/\s+/g, " ") : null;

    const hits: Array<{ sessionId: string; score: number; field: Field }> = [];
    for (const [sessionId, fields] of this.sessions) {
      const found = new Set<number>();
      let best: { field: Field; score: number } | null = null;
      let rest = 0;
      for (const field of fields) {
        const k = this.kindLen[field.kind];
        const avg = k.count ? k.total / k.count : 1;
        let score = 0;
        let matched = 0;
        expanded.forEach((variants, wi) => {
          let wordScore = 0;
          for (const { term, weight, idf } of variants) {
            const tf = field.tf.get(term);
            if (!tf) continue;
            const s = weight * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * field.len) / Math.max(avg, 1))));
            if (s > wordScore) wordScore = s;
          }
          if (wordScore > 0) {
            found.add(wi);
            matched++;
            score += wordScore;
          }
        });
        if (!score) continue;
        // Fields containing more of the query words (and the exact phrase) rank higher.
        score *= WEIGHT[field.kind] * (0.5 + (0.5 * matched) / words.length);
        if (phrase && field.text.toLowerCase().replace(/\s+/g, " ").includes(phrase)) score *= 1.5;
        if (!best || score > best.score) {
          if (best) rest += best.score;
          best = { field, score };
        } else rest += score;
      }
      if (!best) continue;
      if (mode === "all" && found.size < words.length) continue;
      hits.push({ sessionId, score: best.score + 0.5 * Math.log1p(rest), field: best.field });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit).map(({ sessionId, score, field }) => ({
      sessionId,
      score: Math.round(score * 1000) / 1000,
      kind: field.kind,
      snippet: makeSnippet(field.text, words),
    }));
  }

  private idf(term: string): number {
    const n = this.df.get(term) ?? 0;
    return Math.log(1 + (this.fieldCount - n + 0.5) / (n + 0.5));
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Occurrences of query words as word prefixes in `text`, as `[start, end)` ranges. */
function findRanges(text: string, words: readonly string[]): Array<[number, number]> {
  if (!words.length) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...words].sort((a, b) => b.length - a.length).map(escapeRe).join("|")})`, "giu");
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/**
 * A ~160-character excerpt of `text` around the first query word, whitespace collapsed, with
 * every query word highlighted. Pure; exported for tests.
 */
export function makeSnippet(text: string, words: readonly string[], length = SNIPPET_LENGTH): HighlightedText {
  const flat = text.replace(/\s+/g, " ").trim();
  const first = findRanges(flat, words)[0];
  let start = 0;
  if (first && flat.length > length) {
    start = Math.max(0, Math.min(first[0] - Math.floor(length / 3), flat.length - length));
    // Start at a word boundary.
    if (start > 0) {
      const space = flat.indexOf(" ", start);
      if (space !== -1 && space < first[0]) start = space + 1;
    }
  }
  let end = Math.min(flat.length, start + length);
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > start + length / 2) end = space;
  }
  const prefix = start > 0 ? "…" : "";
  const body = flat.slice(start, end);
  const snippet = `${prefix}${body}${end < flat.length ? "…" : ""}`;
  return { text: snippet, highlights: findRanges(body, words).map(([s, e]) => [s + prefix.length, e + prefix.length]) };
}
