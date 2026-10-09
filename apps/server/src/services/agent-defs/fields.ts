/**
 * Reading single agent-definition values (I-218), shared by Glade's format and the discovered
 * formats (Claude Code, Codex, pi): lists written as `a, b` or YAML/TOML lists, enum checks, the
 * Markdown frontmatter split, and model values in Glade's `provider/id` form per harness.
 */
import { CLAUDE_HARNESS_ID, CODEX_HARNESS_ID, INHERIT, THINKING_LEVELS, type ThinkingLevel } from "@glade/protocol";

export const CLAUDE = CLAUDE_HARNESS_ID;
export const CODEX = CODEX_HARNESS_ID;
export const PI = "pi";

/** Glade's provider names for the harnesses with their own model lists (`harness/<id>/models.ts`). */
const MODEL_PROVIDER: Record<string, string> = { [CLAUDE]: "anthropic", [CODEX]: "codex" };

const HARNESS_LABELS: Record<string, string> = { [CLAUDE]: "Claude Code", [CODEX]: "Codex", [PI]: "pi" };

/** "Claude Code", "Codex", "pi", else the id. */
export function harnessLabel(id: string): string {
  return HARNESS_LABELS[id] ?? id;
}

/** `---` frontmatter and the body of a Markdown file (`frontmatter` null when there is none). */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: null, body: text.replace(/^\uFEFF/, "") };
  return { frontmatter: match[1]!, body: match[2]! };
}

/** A non-empty trimmed string, else null (numbers are written as text). */
export function readString(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text : null;
}

/** `a, b` or a list → trimmed non-empty strings; `null` when absent/empty-ish (`[]` stays `[]`). */
export function readList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 0) return [];
  const items = Array.isArray(value) ? value.map(readString) : typeof value === "string" ? value.split(",").map(readString) : [readString(value)];
  const out = items.filter((v): v is string => !!v);
  return out.length ? [...new Set(out)] : null;
}

/** A thinking level (or `inherit`), `null` when it's none of them. */
export function readThinking(value: string | null): ThinkingLevel | typeof INHERIT | null {
  if (!value) return INHERIT;
  const v = value.toLowerCase();
  if (v === INHERIT) return INHERIT;
  if (v === "none") return "off";
  return (THINKING_LEVELS as readonly string[]).includes(v) ? (v as ThinkingLevel) : null;
}

/**
 * A model value as Glade's harness lists it: Claude Code's aliases and ids become `anthropic/<value>`,
 * Codex's `codex/<id>`; pi's (and anything already `provider/id`) stay. `inherit`/empty = inherit.
 */
export function gladeModel(harness: string, model: string | null): string {
  if (!model || model.toLowerCase() === INHERIT) return INHERIT;
  const provider = MODEL_PROVIDER[harness];
  if (provider && !model.includes("/")) return `${provider}/${model}`;
  return model;
}

/** Why `model` can't be a model of `harness` (`null` = it can, or we can't tell). */
export function modelHarnessMismatch(harness: string, model: string): string | null {
  const provider = MODEL_PROVIDER[harness];
  if (!provider || model === INHERIT) return null;
  const slash = model.indexOf("/");
  if (slash > 0 && model.slice(0, slash) !== provider) return `model "${model}" isn't a ${harnessLabel(harness)} model`;
  return null;
}
