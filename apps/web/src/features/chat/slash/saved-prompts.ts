/**
 * Saved prompts (I-098) in the `/` menu: each becomes a `saved` command named after its slug
 * (`/review-diff`); picking it inserts the prompt's text instead of running anything. Pure.
 */
import { promptCommandName, promptsFor, type SavedPrompt, type SlashCommand } from "@glade/protocol";

/** One-line menu description: the prompt's description, else the start of its text. */
function describe(prompt: SavedPrompt): string {
  if (prompt.description) return prompt.description;
  const line = prompt.body.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/** Menu entries for a chat in `projectId` (`null` = standalone). */
export function savedPromptCommands(prompts: readonly SavedPrompt[] | null | undefined, projectId: string | null): SlashCommand[] {
  return promptsFor(prompts, projectId).map((p) => ({ name: promptCommandName(p.name), description: describe(p), source: "saved" }));
}

/** The saved prompt `/name` stands for in a chat of `projectId`, if any. */
export function findSavedPrompt(prompts: readonly SavedPrompt[] | null | undefined, projectId: string | null, name: string): SavedPrompt | null {
  return promptsFor(prompts, projectId).find((p) => promptCommandName(p.name) === name) ?? null;
}

/** `commands` plus the saved prompts whose names don't clash with one of them. */
export function withSavedPrompts(commands: SlashCommand[], saved: SlashCommand[]): SlashCommand[] {
  if (saved.length === 0) return commands;
  const taken = new Set(commands.map((c) => c.name));
  return [...commands, ...saved.filter((c) => !taken.has(c.name))];
}
