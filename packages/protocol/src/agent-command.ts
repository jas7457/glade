/**
 * A custom command per agent (I-201), behind the Advanced switch on the agent's page: e.g. a work
 * setup that must start pi through a wrapper (`mywrapper pi --offline`). Stored per device in
 * `Settings.agents.<harnessId>` as `advanced` + `command` (next to `enabled`).
 *
 * - Off means Glade's own command (`pi`, `claude`, `codex`), always, even when a custom one is
 *   saved; the saved one stays and applies again when Advanced is switched back on.
 * - The command is split like a shell would split it (quotes and backslashes respected) but never
 *   run through a shell: no `$VARIABLES`, `~`, globs, pipes or redirects. The first word is the
 *   program (looked up on the PATH), the rest are leading arguments; Glade appends its own.
 * - Glade's own flags are reserved ({@link RESERVED_AGENT_ARGS}); a command using one is refused.
 * - Version checks run `<command> --version`, Update runs the agent's updater through it
 *   (`mywrapper pi update self`, `<command> update` for Claude Code and Codex).
 *
 *   splitCommandLine(`mywrapper pi --skill "my skills"`)  // ["mywrapper", "pi", "--skill", "my skills"]
 *   agentCommandError("pi", "mywrapper pi --mode json")   // "`--mode` is set by Glade: remove it."
 *   customAgentCommand(settings, "pi")                    // { program: "mywrapper", args: ["pi"] } | null
 */
import { builtinAgentCommand, CLAUDE_HARNESS_ID, CODEX_HARNESS_ID, type AgentSwitches } from "./agent-catalog.js";
import { AGENT_UPDATE_COMMANDS } from "./agent-versions.js";

/** A command split into the program and its leading arguments. */
export interface AgentCommandLine {
  program: string;
  args: string[];
}

/** `POST /api/agent-command/test` (this device only): runs `<command> --version`. */
export interface AgentCommandTestRequest {
  harness: string;
  /** The command to try (not necessarily saved yet); empty = the built-in one. */
  command: string;
}

export interface AgentCommandTestResult {
  ok: boolean;
  /** What ran, e.g. `mywrapper pi --version`. */
  command: string;
  /** The version it printed (the last x.y.z), null when none. */
  version: string | null;
  /** Its output (stdout + stderr, trimmed, at most a few KB). */
  output: string;
  /** Why it failed, in a sentence. */
  error?: string;
}

/** Longest command accepted. */
export const MAX_AGENT_COMMAND_LENGTH = 2000;

/**
 * Arguments Glade passes itself, per agent: a custom command may not use them (flags also as
 * `--flag=value`). Harmless ones (`--offline`, extra `--skill` or `-e` paths, `-c key=value` for
 * Codex…) pass through.
 */
export const RESERVED_AGENT_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  pi: [
    "--mode",
    "--session",
    "--no-session",
    "--session-id",
    "--session-dir",
    "--fork",
    "--continue",
    "-c",
    "--resume",
    "-r",
    "--model",
    "--provider",
    "--thinking",
    "--print",
    "-p",
    "--no-extensions",
    "-ne",
    "--system-prompt",
    "--append-system-prompt",
    "--tools",
    "-t",
    "--no-tools",
    "-nt",
    "--export",
    "--list-models",
    "--help",
    "-h",
    "--version",
    "-v",
  ],
  [CLAUDE_HARNESS_ID]: [
    "--print",
    "-p",
    "--output-format",
    "--input-format",
    "--model",
    "--fallback-model",
    "--resume",
    "-r",
    "--continue",
    "-c",
    "--session-id",
    "--fork-session",
    "--permission-mode",
    "--permission-prompt-tool",
    "--mcp-config",
    "--strict-mcp-config",
    "--setting-sources",
    "--system-prompt",
    "--append-system-prompt",
    "--max-turns",
    "--max-budget-usd",
    "--max-thinking-tokens",
    "--thinking",
    "--effort",
    "--tools",
    "--allowedTools",
    "--allowed-tools",
    "--disallowedTools",
    "--disallowed-tools",
    "--include-partial-messages",
    "--no-session-persistence",
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--help",
    "-h",
    "--version",
    "-v",
  ],
  [CODEX_HARNESS_ID]: ["app-server", "--help", "-h", "--version", "-V"],
});

/** A command that can't be split (an open quote) or would need a shell. */
export class CommandLineError extends Error {}

const SHELL_ONLY = new Set(["|", "&", ";", "<", ">", "(", ")", "`"]);

/**
 * Split `text` into words like a POSIX shell (single quotes literal; double quotes with `\"`,
 * `\\`, `\$`, `` \` ``; a backslash outside quotes escapes the next character), without any
 * expansion. Throws {@link CommandLineError} for an open quote or unquoted shell syntax
 * (pipes, redirects, `;`, `&`, `$`, backticks), since nothing runs it through a shell.
 */
export function splitCommandLine(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    inWord = true;
    if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new CommandLineError("A ' quote isn't closed.");
      word += text.slice(i + 1, end);
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === "\\" && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1]!)) {
          if (text[j + 1] !== "\n") word += text[j + 1];
          j++;
        } else word += text[j];
      }
      if (j >= text.length) throw new CommandLineError('A " quote isn\'t closed.');
      i = j;
    } else if (ch === "\\") {
      if (i + 1 < text.length) {
        if (text[i + 1] !== "\n") word += text[i + 1];
        i++;
      } else word += ch;
    } else if (SHELL_ONLY.has(ch)) {
      throw new CommandLineError(`Glade runs the command without a shell, so \`${ch}\` doesn't work here: quote it, or put it in a wrapper script.`);
    } else if (ch === "$") {
      throw new CommandLineError("Variables like $HOME aren't expanded (there's no shell): write the value, or use a wrapper script.");
    } else {
      word += ch;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** One word, quoted for a POSIX shell when it needs it. */
export function quoteShellWord(word: string): string {
  if (word !== "" && /^[A-Za-z0-9_\-+=.,/:@%^]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Words joined into a command line a shell splits back into the same words. */
export function formatCommandLine(words: readonly string[]): string {
  return words.map(quoteShellWord).join(" ");
}

function reservedFor(harnessId: string): ReadonlySet<string> {
  return new Set(RESERVED_AGENT_ARGS[harnessId] ?? []);
}

/**
 * Why `text` can't be `harnessId`'s command, or null when it can (empty = the built-in command).
 * Shown under the field and returned by the settings API (400).
 */
export function agentCommandError(harnessId: string, text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const builtin = builtinAgentCommand(harnessId);
  if (!builtin) return "Only pi, Claude Code and Codex can run a custom command.";
  if (trimmed.length > MAX_AGENT_COMMAND_LENGTH) return `The command is too long (at most ${MAX_AGENT_COMMAND_LENGTH} characters).`;
  let words: string[];
  try {
    words = splitCommandLine(trimmed);
  } catch (err) {
    return (err as Error).message;
  }
  const [program, ...args] = words;
  if (!program) return "Enter a command.";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) return "Set environment variables in a wrapper script: the first word is the program Glade starts.";
  const reserved = reservedFor(harnessId);
  for (const arg of args) {
    const name = arg.startsWith("--") ? arg.split("=")[0]! : arg;
    if (reserved.has(name)) return `\`${name}\` is set by Glade: remove it from the command.`;
  }
  return null;
}

/**
 * The custom command in effect for `harnessId`, or null for Glade's own: only when Advanced is on
 * and a valid command is saved (a stored command that isn't valid falls back to the built-in one).
 */
export function customAgentCommand(settings: { agents?: AgentSwitches } | null | undefined, harnessId: string): AgentCommandLine | null {
  const entry = settings?.agents?.[harnessId];
  if (entry?.advanced !== true || typeof entry.command !== "string" || !entry.command.trim()) return null;
  if (agentCommandError(harnessId, entry.command)) return null;
  const [program, ...args] = splitCommandLine(entry.command.trim());
  return program ? { program, args } : null;
}

/** The command `harnessId` runs: the custom one in effect, else the built-in (`args` empty). */
export function effectiveAgentCommand(settings: { agents?: AgentSwitches } | null | undefined, harnessId: string): AgentCommandLine & { custom: boolean } {
  const custom = customAgentCommand(settings, harnessId);
  if (custom) return { ...custom, custom: true };
  return { program: builtinAgentCommand(harnessId) ?? harnessId, args: [], custom: false };
}

/**
 * The updater command for `harnessId` through `custom` (the agent's own updater with its program
 * replaced: `pi update self` → `mywrapper pi update self`), or the built-in one; null when Glade can't
 * update the agent. Quoted for the login shell it runs in.
 */
export function agentUpdateCommand(harnessId: string, custom: AgentCommandLine | null): string | null {
  const base = AGENT_UPDATE_COMMANDS[harnessId];
  if (!base) return null;
  if (!custom) return base;
  const [, ...rest] = splitCommandLine(base);
  return formatCommandLine([custom.program, ...custom.args, ...rest]);
}
