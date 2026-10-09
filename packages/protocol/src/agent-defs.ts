/**
 * Glade agents (I-218): reusable sub-agent definitions an orchestrator picks when it calls
 * `spawn_agent`, and the sub-agents' harness choice (I-217).
 *
 * - **Harness-first.** Every agent runs on one harness (`pi`, `claude`, `codex`) or `inherit`s its
 *   parent's. Its model is a value of that harness's model list (`inherit` = the parent's model, or
 *   the harness's sub-agent model setting). A specific model needs a specific harness.
 * - **Glade's own files, never anyone else's.** Glade agents are Markdown files with YAML
 *   frontmatter (Claude Code's field names where they mean the same) in Glade's data folder
 *   (`<data>/agents/*.md`, scope `personal`) or a project's `.agents/agents/*.md` (scope `project`).
 *   Glade never writes to `~/.claude/agents`, `~/.codex/agents`, pi's folders, etc.
 * - **One agent per name (I-220).** Names are unique across everything listed (Glade's and
 *   discovered, any scope); two agents with one name are both unavailable (a problem on each)
 *   until one is renamed or removed. The one exception is a **customization**: a Glade file named
 *   like its source that `extends` it. A source has at most one, it is listed on the source's row
 *   (`customizedBy` / `customizes`) and is what chats get; resetting it deletes the file.
 * - **Discovered agents** from Claude Code (`~/.claude/agents`, `<project>/.claude/agents`), Codex
 *   (`~/.codex/agents/*.toml`, `<project>/.codex/agents`) and pi (`~/.pi/agent/agents`,
 *   `<project>/.pi/agents`, pi packages' `agents/`) are listed live, read-only, usable as they are.
 * - **`extends`** (`claude:<name>`, `codex:<name>`, `pi:<name>` or a file path) references another
 *   agent instead of copying it: read fresh at every spawn; the Glade file's fields override the
 *   source's only when set; its body is appended to the source's prompt. In an `extends` file,
 *   `harness`/`model`/`thinking` = `inherit` (or omitted) mean "the source's value", not the
 *   parent's; other fields that are null / [] / "" are likewise taken from the source.
 * - **Identity:** `nicknames` (first free one is used; when all are taken, numbering: "Brandon 2";
 *   none = the random name pool), optional `color` (`AgentColor`) and `icon` ({@link AGENT_ICONS}).
 *
 * File format (personal or project Glade agent):
 *
 * ```markdown
 * ---
 * name: scout
 * description: Fast read-only code search. Use before changing code to find files and symbols.
 * harness: claude
 * model: haiku
 * thinking: off
 * nickname: [Brandon, Bea]
 * color: teal
 * icon: search
 * tools: Read, Grep, Glob
 * ---
 * Trace the real code path, cite file:line, never propose fixes unless asked.
 * ```
 */
import type { AgentColor } from "./agents.js";
import type { ThinkingLevel } from "./models.js";

/** `harness`, `model` and `thinking` value meaning "the parent's" (Claude Code / Cursor's word). */
export const INHERIT = "inherit";

/** Icons an agent can show on its card and tab (lucide names, rendered by the clients). */
export const AGENT_ICONS = ["search", "hammer", "shield", "book", "flask", "compass", "bug", "pen", "eye", "wrench", "rocket", "sparkles"] as const;
export type AgentIcon = (typeof AGENT_ICONS)[number];

/** Where an agent definition comes from. Only `personal` and `project` are Glade's (editable). */
export type AgentDefSource = "personal" | "project" | "claude" | "codex" | "pi";

/** Glade agents' scopes: Glade's data folder, or the project's `.agents/agents`. */
export type AgentDefScope = "personal" | "project";

/** Codex's sandbox modes (`sandbox_mode`). */
export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/**
 * What a Glade agent file says (the editor's fields). Harness-specific fields only apply on that
 * harness: `tools` (pi and Claude Code, the harness's own tool names), `disallowedTools` and
 * `permissionMode` (Claude Code), `sandbox` (Codex). `null`/empty = not set (inherit/default).
 */
export interface AgentDefFields {
  /** Lowercase letters, digits, dashes (`scout`); unique within its scope. What the orchestrator picks. */
  name: string;
  /** When to use it ("Use when…, not for…"); read only by the orchestrator. */
  description: string;
  /** Harness id or {@link INHERIT}. */
  harness: string;
  /** A model value of `harness`'s list (Glade's `provider/id`), or {@link INHERIT}. */
  model: string;
  thinking: ThinkingLevel | typeof INHERIT;
  /** `claude:<name>` / `codex:<name>` / `pi:<name>` / a file path; `null` = a standalone agent. */
  extends: string | null;
  /** Human names (I-218): the first free one is used, then numbering. Empty = the random pool. */
  nicknames: string[];
  color: AgentColor | null;
  icon: AgentIcon | null;
  /** Tool allowlist (pi / Claude Code tool names). `null` = the harness's defaults. */
  tools: string[] | null;
  /** Claude Code: tools denied. */
  disallowedTools: string[] | null;
  /** Claude Code: `default`, `acceptEdits`, `plan`, `bypassPermissions`, … */
  permissionMode: string | null;
  /** Codex: sandbox mode. */
  sandbox: CodexSandboxMode | null;
  /** The prompt (Markdown body): read only by the sub-agent. With `extends`, appended to the source's. */
  prompt: string;
}

/** One agent as Settings and the orchestrator see it (`GET /api/agent-defs`). */
export interface AgentDef {
  /** Stable key: `<source>:<name>` (e.g. `personal:scout`, `project:scout`, `claude:code-reviewer`). */
  id: string;
  source: AgentDefSource;
  /** The file it's read from (shown in Settings; `~` for the home folder). */
  path: string;
  /** Glade's own (`personal`/`project`): editable and deletable. */
  editable: boolean;
  /** The file as written (for discovered agents: translated into Glade's fields). */
  fields: AgentDefFields;
  /**
   * After `extends` and translation: what a spawn uses. `harness`/`model`/`thinking` may still be
   * `inherit` (resolved against the parent at spawn).
   */
  effective: AgentDefFields;
  /**
   * With `extends`: the source's effective fields alone, i.e. what the agent would be without this
   * file's overrides (the editor greys these as "From …" placeholders). `null` without `extends` or
   * when the source isn't found.
   */
  base: AgentDefFields | null;
  /** Turned on for this project (global switch, then the project's override). */
  enabled: boolean;
  /** Can run now: its harness is installed and on, its `extends` source exists, no errors. */
  available: boolean;
  /** Why not available, or warnings (e.g. "source not found", "fields not used on Codex: hooks"). */
  problems: string[];
  /**
   * On a Glade file that customizes a listed agent (same name, `extends: <tool>:<name>`; I-220):
   * the id of that source (`pi:scout`). Clients show it on the source's row, not as an agent of
   * its own.
   */
  customizes: string | null;
  /**
   * On a listed agent (Claude Code / Codex / pi) that has a customization: the id of the Glade file
   * that is used instead (`personal:scout`). The source itself isn't offered to chats then.
   */
  customizedBy: string | null;
}

/** `GET /api/agent-defs?projectId=` */
export interface ListAgentDefsResponse {
  agents: AgentDef[];
}

/**
 * `PUT /api/agent-defs` (create or replace a Glade agent; `previousName` renames). 409 when the
 * name is taken by another listed agent, or the source already has a customization (I-220).
 */
export interface SaveAgentDefRequest {
  scope: AgentDefScope;
  /** Required for scope `project`; for `personal` the project being looked at (name checks include its agents). */
  projectId?: string | null;
  fields: AgentDefFields;
  /** The name it had before (rename); absent = create or overwrite by `fields.name`. */
  previousName?: string;
}

export interface SaveAgentDefResponse {
  agent: AgentDef;
}

/** `DELETE /api/agent-defs?scope=&name=&projectId=` → 204. */

/** `POST /api/agent-defs/describe`: draft a description from the prompt (quick-tasks model). */
export interface DescribeAgentDefRequest {
  name: string;
  harness: string;
  prompt: string;
}
export interface DescribeAgentDefResponse {
  description: string;
}

/**
 * `GET /api/agent-defs/tools?harness=&projectId=`: the harness's tools as last seen in a session of
 * that project (pi: every registered tool incl. extensions and MCP; Claude Code: the session's init
 * `tools` and MCP servers). Codex has no tool allowlist (empty). `seenAt` null = never seen yet.
 */
export interface AgentDefToolsResponse {
  harness: string;
  tools: string[];
  mcpServers: string[];
  seenAt: number | null;
}

/**
 * Switching agents on/off (`Settings.agentDefs`): by agent name. A project's override wins over
 * the global switch. Absent = on.
 */
export interface AgentDefSwitches {
  /** Names turned off everywhere. */
  disabled: string[];
  /** Per project id: name → on/off, overriding `disabled`. */
  projects: Record<string, Record<string, boolean>>;
}

/** Whether agent `name` is on in `projectId` (`null` = a standalone chat). */
export function agentDefEnabled(switches: AgentDefSwitches | null | undefined, name: string, projectId: string | null): boolean {
  const own = projectId ? switches?.projects?.[projectId]?.[name] : undefined;
  if (own !== undefined) return own;
  return !(switches?.disabled ?? []).includes(name);
}

export const MAX_AGENT_DEF_NAME = 64;
export const MAX_AGENT_DEF_DESCRIPTION = 1_000;
export const MAX_AGENT_DEF_PROMPT = 50_000;
export const MAX_AGENT_NICKNAMES = 12;

/** `scout`, `code-reviewer`: lowercase letters, digits, dashes (underscores become dashes). */
export function normalizeAgentDefName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_AGENT_DEF_NAME);
}

/** Empty fields for a new agent on `harness` (`inherit` everywhere else). */
export function emptyAgentDefFields(harness: string = INHERIT): AgentDefFields {
  return {
    name: "",
    description: "",
    harness,
    model: INHERIT,
    thinking: INHERIT,
    extends: null,
    nicknames: [],
    color: null,
    icon: null,
    tools: null,
    disallowedTools: null,
    permissionMode: null,
    sandbox: null,
    prompt: "",
  };
}
