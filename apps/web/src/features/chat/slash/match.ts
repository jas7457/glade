/**
 * Pure slash-command helpers: parse the composer text, filter/rank commands, group them.
 */
import type { SlashCommand, SlashCommandSource } from "@glade/protocol";

export interface ParsedSlash {
  /** Command name as typed (no slash). */
  name: string;
  /** Everything after the first whitespace, trimmed. */
  args: string;
  /** Whether the user has moved on to the arguments (typed whitespace after the name). */
  hasArgs: boolean;
}

/** `/name args…` at the very start of the text → parts; anything else → `null`. */
export function parseSlash(text: string): ParsedSlash | null {
  const match = /^\/([^\s/][^\s]*|)(\s[\s\S]*)?$/.exec(text);
  if (!match) return null;
  const rest = match[2];
  return { name: match[1] ?? "", args: rest?.trim() ?? "", hasArgs: rest !== undefined };
}

export const GROUP_ORDER: SlashCommandSource[] = ["builtin", "extension", "skill", "prompt"];
export const GROUP_LABELS: Record<SlashCommandSource, string> = {
  builtin: "Built-in",
  extension: "Extensions",
  skill: "Skills",
  prompt: "Prompts",
};

/** Characters of `query` appear in order in `text`. */
function isSubsequence(query: string, text: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === query[i]) i++;
  return i === query.length;
}

const FUZZY_SCORE = 4;

/** Lower is better; `null` = no match. */
export function scoreCommand(command: SlashCommand, query: string): number | null {
  const q = query.toLowerCase();
  if (!q) return 0;
  const name = command.name.toLowerCase();
  const bare = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name; // "skill:web-design" → "web-design"
  if (name === q || bare === q) return 0;
  if (name.startsWith(q) || bare.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (command.description?.toLowerCase().includes(q)) return 3;
  if (isSubsequence(q, name)) return FUZZY_SCORE;
  return null;
}

/** Sort key: the name without a `skill:`-style prefix, lower-cased. */
function sortName(command: SlashCommand): string {
  const name = command.name.toLowerCase();
  return name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
}

/** Alphabetical (case-insensitive, ignoring the `skill:` prefix); full name breaks ties. */
export function compareCommandNames(a: SlashCommand, b: SlashCommand): number {
  const x = sortName(a);
  const y = sortName(b);
  if (x !== y) return x < y ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export interface CommandGroup {
  source: SlashCommandSource;
  label: string;
  commands: SlashCommand[];
}

/**
 * Commands matching `query` (substring/fuzzy on name + description), grouped Built-in /
 * Extensions / Skills / Prompts; best matches first within a group, ties (and everything for
 * an empty query) in alphabetical order (I-049).
 */
export function filterCommands(commands: SlashCommand[], query: string): CommandGroup[] {
  let scored = commands
    .map((command, index) => ({ command, index, score: scoreCommand(command, query) }))
    .filter((s): s is { command: SlashCommand; index: number; score: number } => s.score !== null)
    .sort((a, b) => a.score - b.score || compareCommandNames(a.command, b.command) || a.index - b.index);
  // Fuzzy (subsequence) matches are only a fallback; they're noise next to real matches.
  if (scored.some((s) => s.score < FUZZY_SCORE)) scored = scored.filter((s) => s.score < FUZZY_SCORE);
  const groups = GROUP_ORDER.map((source, order) => {
    const matches = scored.filter((s) => s.command.source === source);
    return { source, label: GROUP_LABELS[source], commands: matches.map((s) => s.command), best: matches[0]?.score ?? Infinity, order };
  }).filter((g) => g.commands.length > 0);
  // The group holding the best match comes first, so Enter/Tab pick it; ties keep the usual order.
  groups.sort((a, b) => a.best - b.best || a.order - b.order);
  return groups.map(({ source, label, commands }) => ({ source, label, commands }));
}

/** Built-ins first, then harness commands whose names don't clash with a built-in. */
export function mergeCommands(builtins: SlashCommand[], harness: SlashCommand[] | null | undefined): SlashCommand[] {
  const taken = new Set(builtins.map((c) => c.name));
  return [...builtins, ...(harness ?? []).filter((c) => !taken.has(c.name))];
}
