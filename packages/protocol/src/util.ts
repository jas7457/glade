import type { DeepPartial } from "./api.js";

/** Recursively merge plain objects. Arrays and primitives in `patch` replace values in `base`. */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = (base as Record<string, unknown>)[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Instant, free title derived from the first user message: first meaningful line with
 * markdown noise stripped, truncated at a word boundary.
 */
export function quickTitle(text: string, maxLength = 60): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("```")) ?? "";
  const cleaned = line
    .replace(/^#+\s*/, "")
    .replace(/^[-*>]\s+/, "")
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "New chat";
  if (cleaned.length <= maxLength) return cleaned;
  const cut = cleaned.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.5 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:!?-]+$/, "")}…`;
}
