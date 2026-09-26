/**
 * Fuzzy matching and ranking for the command palette (pure, no UI).
 *
 * `fuzzyMatch` scores one text against a query: every whitespace-separated query word must
 * match, as a prefix of the text (best), the start of a word, a substring, or a subsequence
 * (letters in order starting at a word, e.g. "nwc" → "New Chat"). `rankItems` filters and groups items: with an
 * empty query groups keep their given order and items their input order; with a query the
 * group holding the best match comes first and items are sorted by score, so the first row is
 * always the best match.
 */

export interface MatchResult {
  score: number;
  /** Indices of matched characters in the text (for highlighting). */
  indices: number[];
}

const isWordStart = (text: string, i: number) => i === 0 || /[\s\-_/.:(\[]/.test(text[i - 1]!) || (/[a-z]/.test(text[i - 1]!) && /[A-Z]/.test(text[i]!));

function matchWord(text: string, lower: string, word: string): MatchResult | null {
  const range = (start: number) => Array.from({ length: word.length }, (_, k) => start + k);
  if (lower.startsWith(word)) return { score: 100, indices: range(0) };
  // A word start anywhere in the text.
  for (let i = lower.indexOf(word, 1); i !== -1; i = lower.indexOf(word, i + 1)) {
    if (isWordStart(text, i)) return { score: 80, indices: range(i) };
  }
  const sub = lower.indexOf(word);
  if (sub !== -1) return { score: 55, indices: range(sub) };
  // Subsequence: prefer letters at word starts, penalise gaps.
  const indices: number[] = [];
  let from = 0;
  let score = 40;
  for (const ch of word) {
    let at = -1;
    for (let i = from; i < lower.length; i++) {
      if (lower[i] !== ch) continue;
      if (at === -1) at = i;
      if (isWordStart(text, i)) {
        at = i;
        break;
      }
    }
    if (at === -1) return null;
    const prev = indices.length ? indices[indices.length - 1]! : -1;
    if (!isWordStart(text, at) && at !== prev + 1) {
      // Must start at a word ("gr" shouldn't find "Casual greeting" via "caSual… grEeTing").
      if (prev === -1) return null;
      score -= 3;
    }
    indices.push(at);
    from = at + 1;
  }
  return { score: Math.max(score, 5), indices };
}

/** Score `text` against `query` (case-insensitive). `null` = no match. Empty query matches with 0. */
export function fuzzyMatch(query: string, text: string): MatchResult | null {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, indices: [] };
  const lower = text.toLowerCase();
  let score = 0;
  const indices = new Set<number>();
  for (const word of words) {
    const m = matchWord(text, lower, word);
    if (!m) return null;
    score += m.score;
    m.indices.forEach((i) => indices.add(i));
  }
  score /= words.length;
  if (lower === query.toLowerCase().trim()) score += 50;
  // Shorter texts win ties ("Settings" over "Settings: Appearance").
  score -= Math.min(text.length, 80) / 20;
  return { score, indices: [...indices].sort((a, b) => a - b) };
}

export interface RankableItem {
  title: string;
  group: string;
  /** Extra words that match (less strongly than the title). */
  keywords?: readonly string[];
  /** Only shown when there's a query. */
  searchOnly?: boolean;
}

export interface RankedItem<T> {
  item: T;
  score: number;
  /** Matched title characters. */
  indices: number[];
}

export interface RankedGroup<T> {
  group: string;
  items: RankedItem<T>[];
}

export interface RankOptions {
  /** Group order for an empty query (unknown groups go last). */
  groupOrder?: readonly string[];
  /** Max items per group with an empty query (default: unlimited). */
  emptyLimit?: Readonly<Record<string, number>>;
  /** Max items per group with a query (default 8). */
  limit?: number;
}

export function scoreItem(item: RankableItem, query: string): MatchResult | null {
  const title = fuzzyMatch(query, item.title);
  let best = title;
  for (const keyword of item.keywords ?? []) {
    const m = fuzzyMatch(query, `${item.title} ${keyword}`);
    if (m && (!best || m.score * 0.8 > best.score)) {
      best = { score: m.score * 0.8, indices: m.indices.filter((i) => i < item.title.length) };
    }
  }
  return best;
}

export function rankItems<T extends RankableItem>(items: readonly T[], query: string, options: RankOptions = {}): RankedGroup<T>[] {
  const { groupOrder = [], emptyLimit = {}, limit = 8 } = options;
  const order = (g: string) => {
    const i = groupOrder.indexOf(g);
    return i === -1 ? groupOrder.length : i;
  };
  const byGroup = new Map<string, RankedItem<T>[]>();
  const add = (r: RankedItem<T>) => {
    const list = byGroup.get(r.item.group) ?? [];
    list.push(r);
    byGroup.set(r.item.group, list);
  };

  if (!query.trim()) {
    for (const item of items) if (!item.searchOnly) add({ item, score: 0, indices: [] });
    return [...byGroup.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([group, list]) => ({ group, items: list.slice(0, emptyLimit[group] ?? list.length) }));
  }

  for (const item of items) {
    const m = scoreItem(item, query);
    if (m) add({ item, ...m });
  }
  return [...byGroup.entries()]
    .map(([group, list]) => ({ group, items: list.sort((a, b) => b.score - a.score).slice(0, limit) }))
    .sort((a, b) => b.items[0]!.score - a.items[0]!.score || order(a.group) - order(b.group));
}
