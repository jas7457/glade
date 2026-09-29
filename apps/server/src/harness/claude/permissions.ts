/**
 * Claude Code's permissions in Glade (I-174). Pure, apart from reading its settings files.
 *
 * - **The card** is Claude Code's own prompt: "Yes"; "Yes, and don't ask again for …" worded from
 *   the suggestions `canUseTool` gets, like the CLI words them (`alwaysAllowLabel`); "No, and tell
 *   Claude what to do differently" (denies, stops the turn; the composer gets the focus).
 * - **Permission modes** (`claudePermissionModes`): Default → Accept edits → Plan mode → Auto
 *   (models with `supportsAutoMode`) → Bypass permissions, the order Shift+Tab cycles them. Bypass
 *   is left out when Claude Code's settings disable it (`disableBypassPermissionsMode`).
 * - **The starting mode** of a new chat is Claude Code's own `permissions.defaultMode`
 *   (`readClaudePermissionSettings`: user, project, local and managed settings), else Default.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { PermissionModeInfo, PermissionOption } from "@glade/protocol";
import type { ClaudeModelInfo } from "./sdk.js";

/** Claude Code's permission modes (`PermissionMode` of the SDK). */
export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";

const MODES: Record<ClaudePermissionMode, PermissionModeInfo> = {
  default: { id: "default", label: "Default", description: "Asks before edits and commands" },
  acceptEdits: { id: "acceptEdits", label: "Accept edits", description: "Edits files without asking" },
  plan: { id: "plan", label: "Plan mode", description: "Researches and plans without making changes" },
  auto: { id: "auto", label: "Auto mode", description: "A reviewer model approves routine actions" },
  bypassPermissions: { id: "bypassPermissions", label: "Bypass permissions", description: "Runs everything without asking", danger: true },
  dontAsk: { id: "dontAsk", label: "Don't ask", description: "Denies anything that would ask" },
};

export function isClaudePermissionMode(mode: unknown): mode is ClaudePermissionMode {
  return typeof mode === "string" && Object.hasOwn(MODES, mode);
}

export function claudePermissionModeLabel(mode: string): string {
  return isClaudePermissionMode(mode) ? MODES[mode].label : mode;
}

/**
 * The modes a chat can switch to, in Shift+Tab order. `current` stays listed even when it isn't
 * one of the cycle's (Claude Code's `dontAsk` from its settings).
 */
export function claudePermissionModes(model: Pick<ClaudeModelInfo, "supportsAutoMode"> | undefined, options: { bypassDisabled?: boolean; current?: string | null } = {}): PermissionModeInfo[] {
  const ids: ClaudePermissionMode[] = ["default", "acceptEdits", "plan"];
  if (model?.supportsAutoMode) ids.push("auto");
  if (!options.bypassDisabled) ids.push("bypassPermissions");
  if (isClaudePermissionMode(options.current) && !ids.includes(options.current)) ids.push(options.current);
  return ids.map((id) => MODES[id]);
}

// Settings -----------------------------------------------------------------------------------------

export interface ClaudePermissionSettings {
  /** `permissions.defaultMode` ("manual" read as "default"), `null` when none is set. */
  defaultMode: ClaudePermissionMode | null;
  /** `permissions.disableBypassPermissionsMode: "disable"` in any settings file. */
  bypassDisabled: boolean;
}

/** Claude Code's settings files for a folder, lowest precedence first. */
export function claudeSettingsFiles(cwd: string, home = homedir()): string[] {
  return [
    join(home, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json",
  ];
}

/** Claude Code's permission settings for a folder (unreadable files are skipped). */
export function readClaudePermissionSettings(cwd: string, files = claudeSettingsFiles(cwd)): ClaudePermissionSettings {
  const out: ClaudePermissionSettings = { defaultMode: null, bypassDisabled: false };
  for (const file of files) {
    let permissions: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { permissions?: unknown };
      permissions = parsed.permissions && typeof parsed.permissions === "object" ? (parsed.permissions as Record<string, unknown>) : undefined;
    } catch {
      continue;
    }
    if (!permissions) continue;
    const mode = permissions.defaultMode === "manual" ? "default" : permissions.defaultMode;
    if (isClaudePermissionMode(mode)) out.defaultMode = mode;
    if (permissions.disableBypassPermissionsMode === "disable") out.bypassDisabled = true;
  }
  return out;
}

// The card ------------------------------------------------------------------------------------------

/** A `PermissionUpdate` of the SDK, read loosely. */
interface Suggestion {
  type?: string;
  mode?: string;
  destination?: string;
  rules?: Array<{ toolName?: string; ruleContent?: string }>;
  directories?: string[];
}

/** Commands of a shell rule's content: `npm test:*` / `npm test *` → `npm test`. */
function commandPrefix(content: string): string {
  return content.endsWith(":*") || content.endsWith(" *") ? content.slice(0, -2) : content;
}

/** `a`, `a and b`, `a, b, and c` (the CLI's lists). */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/** A path as the CLI shows it: `~` for the home folder. */
export function displayPath(path: string, home = homedir()): string {
  if (path === home) return "~";
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

function readPath(content: string): string {
  return content.replace(/\/\*\*$/, "").replace(/^\.\//, "").replace(/^\/\//, "/");
}

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/**
 * The "don't ask again" option's label for Claude's suggestions, in the CLI's words, or `null`
 * when there's nothing to offer:
 *
 *   Bash `npm test:*`             → Yes, and don't ask again for npm test commands in ~/src/app
 *   WebFetch `domain:example.com` → Yes, and don't ask again for example.com
 *   addDirectories `/tmp/x`       → Yes, and always allow access to /tmp/x from this project
 *   setMode acceptEdits           → Yes, allow all edits during this session
 *
 * Several suggestions are joined with "; ", as the CLI does (a folder plus commands: "Yes, and
 * allow access to /tmp/x and npm test commands").
 */
export function alwaysAllowLabel(suggestions: readonly unknown[] | undefined, cwd: string, home = homedir()): string | null {
  if (!suggestions?.length) return null;
  const parts: string[] = [];
  const commands: string[] = [];
  const directories: string[] = [];
  const reads: string[] = [];
  const domains: string[] = [];
  const tools: string[] = [];
  let session = false;
  for (const raw of suggestions) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Suggestion;
    if (s.type === "setMode") {
      if (s.mode === "acceptEdits") parts.push("Yes, allow all edits during this session");
      else if (typeof s.mode === "string") parts.push(`Yes, and switch to ${claudePermissionModeLabel(s.mode).toLowerCase()}`);
    } else if (s.type === "addDirectories") {
      for (const dir of s.directories ?? []) if (typeof dir === "string" && dir.trim()) directories.push(displayPath(dir, home));
    } else if (s.type === "addRules") {
      if (s.destination === "session") session = true;
      for (const rule of s.rules ?? []) {
        const tool = rule?.toolName;
        if (typeof tool !== "string") continue;
        const content = typeof rule.ruleContent === "string" ? rule.ruleContent : undefined;
        if (SHELL_TOOLS.has(tool) && content && commandPrefix(content)) commands.push(commandPrefix(content));
        else if (tool === "WebFetch" && content?.startsWith("domain:")) domains.push(content.slice("domain:".length));
        else if (tool === "Read" && content && readPath(content)) reads.push(displayPath(readPath(content), home));
        else tools.push(content ? `${tool}(${content})` : tool);
      }
    }
  }
  const uniq = (xs: string[]) => [...new Set(xs)];
  const cmds = uniq(commands);
  const places = uniq([...directories, ...reads]);
  if (cmds.length && places.length) {
    parts.push(
      places.length === 1 && cmds.length === 1
        ? `Yes, and allow access to ${places[0]} and ${cmds[0]} commands`
        : `Yes, and allow ${list(places)} access and ${list(cmds)} commands`,
    );
  } else if (cmds.length) {
    parts.push(`Yes, and don't ask again for ${list(cmds)} commands in ${displayPath(cwd, home)}`);
  } else if (directories.length) {
    parts.push(`Yes, and always allow access to ${list(places)} from this project`);
  } else if (reads.length) {
    parts.push(`Yes, allow reading from ${list(uniq(reads))} ${session ? "during this session" : "from this project"}`);
  }
  if (domains.length) parts.push(`Yes, and don't ask again for ${list(uniq(domains))}`);
  if (tools.length) parts.push(`Yes, and don't ask again for ${list(uniq(tools))}${session ? " during this session" : ""}`);
  if (!parts.length) return null;
  // Only the first part keeps its "Yes, …" (the CLI joins whole rows with "; ").
  return parts.map((p, i) => (i === 0 ? p : p.replace(/^Yes, (and )?/, ""))).join("; ");
}

/** The option ids of Claude's permission card. */
export const PERMISSION_ALLOW = "allow";
export const PERMISSION_ALWAYS = "allow_always";
export const PERMISSION_REJECT = "reject";

/** The card's options, in the CLI's order. */
export function claudePermissionOptions(label: string | null): PermissionOption[] {
  return [
    { id: PERMISSION_ALLOW, label: "Yes", kind: "allow_once" },
    ...(label ? [{ id: PERMISSION_ALWAYS, label, kind: "allow_always" as const }] : []),
    { id: PERMISSION_REJECT, label: "No, and tell Claude what to do differently", kind: "reject_once", focusComposer: true },
  ];
}

/** What Claude is told when the user says no (the CLI's words): it stops and waits. */
export const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

/** The mode a set of accepted suggestions switches to (`setMode`), if any. */
export function suggestedMode(suggestions: readonly unknown[] | undefined): ClaudePermissionMode | null {
  for (const raw of suggestions ?? []) {
    const s = raw as Suggestion | null;
    if (s && s.type === "setMode" && isClaudePermissionMode(s.mode)) return s.mode;
  }
  return null;
}
