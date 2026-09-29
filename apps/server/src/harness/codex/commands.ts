/**
 * Codex's slash commands and `!` commands in Glade (I-178). Pure.
 *
 * - **Skills** (`skills/list`) are slash commands (source "skill", named like Codex names them,
 *   e.g. `pdf:pdf`). `/<skill> rest` is sent the way Codex's TUI sends a `$skill` mention: the
 *   text `$<skill> rest` plus a `{type:"skill", name, path}` input item (Codex adds the skill's
 *   SKILL.md to the turn).
 * - **`/review`** is Codex's review (`review/start`, inline in the thread): no arguments reviews
 *   the uncommitted changes; `base <branch>` against a base branch; `commit <sha>` one commit;
 *   anything else are custom review instructions. `/compact` is Glade's built-in. Codex's other TUI
 *   commands (/model, /approvals, /permissions, …) are Glade's pickers.
 * - **`!cmd`** output shared with Codex uses Codex's own record of a user shell command
 *   (`<user_shell_command>`, what its TUI's `!` records in the thread).
 */
import type { SlashCommand } from "@glade/protocol";
import type { ReviewTarget, SkillMetadata, UserInput } from "./protocol.js";

export const REVIEW_COMMAND: SlashCommand = {
  name: "review",
  source: "extension",
  description: "Ask Codex to review your changes (uncommitted by default)",
  argsHint: "[base <branch> | commit <sha> | instructions]",
};

/** Codex's own commands Glade offers (besides its built-ins). */
export const CODEX_COMMANDS: SlashCommand[] = [REVIEW_COMMAND];

/** Codex's commands, then its skills (skills named like a command are left out). */
export function codexSlashCommands(skills: SkillMetadata[]): SlashCommand[] {
  const taken = new Set(CODEX_COMMANDS.map((c) => c.name));
  const out: SlashCommand[] = [...CODEX_COMMANDS];
  for (const skill of skills) {
    if (!skill.enabled || taken.has(skill.name) || /\s/.test(skill.name)) continue;
    taken.add(skill.name);
    const description = skill.interface?.shortDescription || skill.shortDescription || skill.description;
    out.push({ name: skill.name, source: "skill", ...(description ? { description } : {}) });
  }
  return out;
}

/** `/name rest` → name and the rest (trimmed); `null` for text that isn't a slash command. */
export function parseSlashText(text: string): { name: string; args: string } | null {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1]!, args: (match[2] ?? "").trim() } : null;
}

/** `/review` arguments → what Codex reviews. */
export function reviewTarget(args: string): ReviewTarget {
  const text = args.trim();
  if (!text) return { type: "uncommittedChanges" };
  const base = /^(?:--?)?(?:base|branch)(?:\s+|=)(\S+)$/i.exec(text);
  if (base) return { type: "baseBranch", branch: base[1]! };
  const commit = /^(?:--?)?commit(?:\s+|=)([0-9a-f]{4,40})(?:\s+([\s\S]+))?$/i.exec(text);
  if (commit) return { type: "commit", sha: commit[1]!, title: commit[2]?.trim() || null };
  return { type: "custom", instructions: text };
}

/** The input items of `/<skill> rest` (Codex's TUI: the `$skill` mention text + the skill item). */
export function skillInput(skill: SkillMetadata, rest: string): UserInput[] {
  const text = rest ? `$${skill.name} ${rest}` : `$${skill.name}`;
  return [
    { type: "text", text, text_elements: [] },
    { type: "skill", name: skill.name, path: skill.path },
  ];
}

/** Longest shell output shared with Codex (head and tail kept). */
export const SHELL_RECORD_MAX_CHARS = 20_000;

/** A `!cmd` run as Codex records its own TUI's user shell commands. */
export function userShellRecord(command: string, exitCode: number | null, durationMs: number, output: string): string {
  const seconds = (durationMs / 1000).toFixed(4);
  return `<user_shell_command>\n<command>\n${command}\n</command>\n<result>\nExit code: ${exitCode ?? -1}\nDuration: ${seconds} seconds\nOutput:\n${clip(output)}\n</result>\n</user_shell_command>`;
}

function clip(output: string): string {
  if (output.length <= SHELL_RECORD_MAX_CHARS) return output;
  const half = Math.floor(SHELL_RECORD_MAX_CHARS / 2);
  return `${output.slice(0, half)}\n… (${output.length - SHELL_RECORD_MAX_CHARS} characters cut) …\n${output.slice(-half)}`;
}

/** The record as a raw Responses API user message (`thread/inject_items`). */
export function userShellItem(record: string): { type: "message"; role: "user"; content: Array<{ type: "input_text"; text: string }> } {
  return { type: "message", role: "user", content: [{ type: "input_text", text: record }] };
}

/** The command line as argv for `command/exec`: the user's login shell, so their PATH and aliases apply. */
export function shellArgv(command: string, shell: string | undefined): string[] {
  return [shell && shell.startsWith("/") ? shell : "/bin/zsh", "-lc", command];
}
