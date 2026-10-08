/**
 * Model families (I-207). No agent reports a model's family, so it's derived from the name: what's
 * left after dropping version numbers ("4.5", "5", "4-5", "Qwen3.8" → "Qwen"), dates and build
 * stamps ("-20251001", "2507"), parameter sizes and quantization ("27B", "Q4_K_M"), and qualifiers
 * ("(latest)", "(EU)", "Preview"):
 *
 *   "Claude Opus 4.5 (latest)" → "Claude Opus"     "GPT-6.1-Sol" → "GPT Sol"     "GPT-5.5" → "GPT"
 *   "Qwen3.8-27B-Q4_K_M"       → "Qwen"            "Daybreak Blue" → "Daybreak Blue" (nothing to strip)
 *
 * The id is the fallback signal: for the version and date when the name has none ("Opus" with id
 * `claude-opus-4-8`), and for the family when the name is nothing but a version. Inside a family
 * models are newest first: by version, an undated alias ("(latest)") before the dated snapshot of
 * the same version, and a versionless "latest" alias on top. Pure; shared by every client so the
 * desktop settings and the iPhone's model lists group the same way.
 */

export interface ModelLike {
  id: string;
  name: string;
}

export interface ModelNameParts {
  /** Family as shown ("Claude Opus"). */
  family: string;
  /** Version parts, newest compares highest (`[4, 5]`); empty when there is none. */
  version: number[];
  /** Date or build stamp (`20251001`, `2507`), or null. */
  date: number | null;
  /** A "latest" alias ("(latest)", `-latest`). */
  latest: boolean;
  /** Parameter count in billions ("27B" → 27), or null. */
  size: number | null;
}

/** Words that qualify a model rather than name its family. */
const QUALIFIERS = new Set(["latest", "preview", "beta", "exp", "experimental", "instruct", "it"]);
/** Quantization and file-format markers of local models. */
const QUANT = /^(i?q\d+(_[a-z0-9]+)*|b?f\d+|fp\d+|int\d+|\d+-?bits?|gguf|mlx|awq|gptq|exl2|qat|ud)$/i;
/** Parameter sizes: "27B", "1.5B", "500M", "8x7B". */
const SIZE = /^(?:(\d+)x)?(\d+(?:\.\d+)?)([bmt])$/i;
/** Active-parameter / effective sizes ("A4B", "E2B"): dropped, never a size. */
const ACTIVE = /^[ae]\d+(\.\d+)?b$/i;
/** A version-ish number: "4", "4.5", "v3", "4o" (the trailing letter is ignored). */
const NUMBER = /^v?(\d+(?:\.\d+)*)[a-z]?$/i;
/** A word glued to its version: "Qwen3.8", "Llama3" (two letters or more, so "o3" and "K2" stay words). */
const GLUED = /^([a-z]{2,})(\d+(?:\.\d+)*)$/i;

/** Parse one string (a name or an id) into family words, version, date and flags. */
function parse(text: string): ModelNameParts {
  // GGUF file names glue the quantization on with a dot: "Mistral-7B-Instruct-v0.3.Q8_0.gguf".
  let s = text
    .trim()
    .replace(/\.gguf$/i, "")
    .replace(/\.(?=[a-z])/gi, " ");
  // "unsloth/Qwen3-…", "openai/gpt-oss-120b": the organization isn't part of the family.
  const slash = s.lastIndexOf("/");
  if (slash >= 0 && slash < s.length - 1) s = s.slice(slash + 1);

  let latest = false;
  let date: number | null = null;
  // Bracketed qualifiers: "(latest)", "(EU)", "(2024-05-13)", "[1m]".
  s = s.replace(/[([]([^)\]]*)[)\]]/g, (_m, inner: string) => {
    if (/\blatest\b/i.test(inner)) latest = true;
    const stamp = inner.match(/\b(\d{4})-(\d{2})-(\d{2})\b/) ?? inner.match(/\b(\d{8})\b/);
    if (stamp && date === null) date = Number(stamp.slice(1).join(""));
    return " ";
  });

  const words: string[] = [];
  const version: number[] = [];
  let size: number | null = null;
  // 0 = no version yet, 1 = in the first run of version numbers, 2 = that run is over.
  let run = 0;
  let single = false; // the run's last number had no dot, so "4-5" can continue it
  const number = (digits: string) => {
    const parts = digits.split(".").map(Number);
    // Three digits or more without a dot is a date or build stamp, not a version.
    if (parts.length === 1 && digits.length >= 3) {
      if (date === null) date = parts[0]!;
      if (run === 1) run = 2;
      return;
    }
    // "4-5" (ids, some names) continues the run: one more version part.
    if (run === 0 || (run === 1 && single && parts.length === 1)) {
      version.push(...parts);
      run = 1;
      single = parts.length === 1;
    } else run = 2;
  };

  for (const raw of s.split(/[\s-]+/)) {
    if (!raw) continue;
    if (QUANT.test(raw)) {
      if (run === 1) run = 2;
      continue;
    }
    for (const token of raw.split("_")) {
      if (!token) continue;
      const glued = token.match(GLUED);
      const sized = token.match(SIZE);
      const num = token.match(NUMBER);
      if (QUALIFIERS.has(token.toLowerCase())) {
        if (token.toLowerCase() === "latest") latest = true;
      } else if (glued) {
        if (run === 1) run = 2;
        words.push(glued[1]!);
        number(glued[2]!);
      } else if (sized) {
        const billions = Number(sized[2]) * Number(sized[1] ?? 1) * ({ m: 0.001, b: 1, t: 1000 }[sized[3]!.toLowerCase() as "m" | "b" | "t"]);
        if (size === null) size = billions;
        if (run === 1) run = 2;
      } else if (ACTIVE.test(token) || QUANT.test(token)) {
        if (run === 1) run = 2;
      } else if (num) {
        number(num[1]!);
      } else {
        if (run === 1) run = 2;
        words.push(token);
      }
    }
  }
  return { family: words.join(" "), version, date, latest, size };
}

/** Family, version, date and flags of a model, from its name with the id as fallback. */
export function modelNameParts(model: ModelLike): ModelNameParts {
  const name = parse(model.name || model.id);
  const id = model.id && model.id !== model.name ? parse(model.id) : name;
  return {
    family: name.family || id.family || (model.name || model.id).trim(),
    version: name.version.length ? name.version : id.version,
    date: name.date ?? id.date,
    latest: name.latest || id.latest,
    size: name.size ?? id.size,
  };
}

/** The family a model belongs to ("Claude Opus 4.5 (latest)" → "Claude Opus"). */
export function modelFamily(model: ModelLike): string {
  return modelNameParts(model).family;
}

/** Compare versions part by part (missing parts count as 0): negative when `a` is older. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Where a model sorts in its family: a versionless "latest" alias first, unversioned models last. */
const rank = (p: ModelNameParts) => (p.version.length ? 1 : p.latest ? 0 : 2);

/** Newest first inside a family (see the header). Ties: bigger first, then by name A–Z. */
export function compareInFamily(a: ModelLike, b: ModelLike): number {
  const pa = modelNameParts(a);
  const pb = modelNameParts(b);
  return (
    rank(pa) - rank(pb) ||
    compareVersions(pb.version, pa.version) ||
    Number(pb.latest) - Number(pa.latest) ||
    // The undated alias sits next to (before) the dated snapshots of its version.
    Number(pa.date !== null) - Number(pb.date !== null) ||
    (pb.date ?? 0) - (pa.date ?? 0) ||
    (pb.size ?? 0) - (pa.size ?? 0) ||
    a.name.localeCompare(b.name)
  );
}

export interface ModelFamilyGroup<T extends ModelLike> {
  /** Grouping key (the family, lower-cased). */
  key: string;
  /** Family as shown, spelled like its newest model. */
  family: string;
  /** Newest first. */
  models: T[];
}

/** Group models by family: families A–Z, models newest first. */
export function groupByFamily<T extends ModelLike>(models: readonly T[]): Array<ModelFamilyGroup<T>> {
  const byKey = new Map<string, T[]>();
  for (const m of models) {
    const key = modelFamily(m).toLowerCase();
    byKey.set(key, [...(byKey.get(key) ?? []), m]);
  }
  return [...byKey.entries()]
    .map(([key, ms]) => {
      const sorted = [...ms].sort(compareInFamily);
      return { key, family: modelFamily(sorted[0]!), models: sorted };
    })
    .sort((a, b) => a.family.localeCompare(b.family, undefined, { sensitivity: "base" }) || a.key.localeCompare(b.key));
}

/**
 * Whether a model matches a filter (case-insensitive): every word of the query appears in its
 * name or id. An empty query matches everything.
 */
export function modelMatches(model: ModelLike, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const name = model.name.toLowerCase();
  const id = model.id.toLowerCase();
  return terms.every((t) => name.includes(t) || id.includes(t));
}
