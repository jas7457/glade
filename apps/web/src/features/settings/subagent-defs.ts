/**
 * Settings → Sub-agents (I-218): pure helpers for the list and the editor: source and harness
 * labels, the model line, the per-harness Read-only preset, and the Customize draft for a
 * discovered agent (a Glade file that `extends` it). Unit-tested.
 */
import { INHERIT, emptyAgentDefFields, parseModelKey, sameModel, type AgentDef, type AgentDefFields, type AgentDefSource, type ModelInfo } from "@glade/protocol";

export const SOURCE_LABELS: Record<AgentDefSource, string> = {
  personal: "Glade",
  project: "Project",
  claude: "Claude Code",
  codex: "Codex",
  pi: "pi",
};

/** Harnesses a new agent can be created on, in the New Agent menu's order. */
export const HARNESS_CHOICES = ["pi", "claude", "codex", INHERIT] as const;

/** Claude Code permission modes offered in the editor (`null` = Claude Code's default). */
export const CLAUDE_PERMISSION_MODES: Array<{ value: string; label: string }> = [
  { value: "default", label: "Ask before edits and commands" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "plan", label: "Plan (read only)" },
  { value: "bypassPermissions", label: "Bypass permissions" },
];

export const CODEX_SANDBOX_LABELS: Record<string, string> = {
  "read-only": "Read only",
  "workspace-write": "Edit the workspace",
  "danger-full-access": "Full access (no sandbox)",
};

/** `claude:reviewer` → "Claude Code"; a file path → the path. */
export function extendsSourceLabel(ref: string | null): string | null {
  if (!ref) return null;
  const colon = ref.indexOf(":");
  const source = colon > 0 ? (ref.slice(0, colon) as AgentDefSource) : null;
  return source && source in SOURCE_LABELS ? SOURCE_LABELS[source] : ref;
}

/** `project:scout` → "Project · scout" (who wins over a shadowed agent). */
export function agentIdLabel(id: string): string {
  const colon = id.indexOf(":");
  if (colon <= 0) return id;
  const source = id.slice(0, colon) as AgentDefSource;
  return `${SOURCE_LABELS[source] ?? source} · ${id.slice(colon + 1)}`;
}

/** The model of its harness's list a value means (`provider/id`, a bare id, Claude Code's `haiku`). */
export function findModel(value: string, models: readonly ModelInfo[]): ModelInfo | undefined {
  if (!value || value === INHERIT) return undefined;
  const ref = parseModelKey(value);
  return (ref && models.find((m) => sameModel(m, ref))) || models.find((m) => m.id === (ref?.id ?? value)) || models.find((m) => m.id === value);
}

/** A model value's label as the model picker shows it, else the raw id. */
export function modelName(value: string, models: readonly ModelInfo[]): string {
  if (!value || value === INHERIT) return "";
  return findModel(value, models)?.name ?? parseModelKey(value)?.id ?? value;
}

/**
 * "Claude Code · Haiku 4.5"; `inherit` model: "Codex · sub-agent model" (that harness's sub-agent
 * model setting, else its default); `inherit` harness: the parent chat's agent and model.
 */
export function harnessModelLine(fields: Pick<AgentDefFields, "harness" | "model">, harnessLabel: (id: string) => string, models: readonly ModelInfo[]): string {
  if (fields.harness === INHERIT) return "Same agent and model as the parent chat";
  const model = fields.model === INHERIT ? "sub-agent model" : modelName(fields.model, models);
  return `${harnessLabel(fields.harness)} · ${model}`;
}

/** Glade's own tools: Glade always gives them to sub-agents, so the tool lists leave them out. */
const GLADE_TOOLS = new Set(["spawn_agent", "message_agent", "list_agents", "close_agent", "report_done", "find_chats", "read_chat", "open_chat"]);

export function isGladeTool(name: string): boolean {
  return name.startsWith("mcp__glade__") || GLADE_TOOLS.has(name);
}

/** Claude Code's tools that can change files; the Read-only preset denies them. */
export const CLAUDE_WRITE_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

/**
 * The Read-only preset for `harness` (I-218: a button, not a generic field): pi gets the read,
 * grep, find and ls tools; Claude Code reads (Read, Grep, Glob, and WebFetch/WebSearch when the
 * session has them) and is denied the editing tools; Codex runs in its read-only sandbox.
 * `null` for `inherit` (no harness-specific settings).
 */
export function readOnlyPreset(harness: string, liveTools: readonly string[]): Partial<AgentDefFields> | null {
  switch (harness) {
    case "pi":
      return { tools: ["read", "grep", "find", "ls"] };
    case "claude":
      return {
        tools: ["Read", "Grep", "Glob", ...["WebFetch", "WebSearch"].filter((t) => liveTools.includes(t))],
        disallowedTools: [...CLAUDE_WRITE_TOOLS],
      };
    case "codex":
      return { sandbox: "read-only" };
    default:
      return null;
  }
}

/**
 * Customize a discovered agent (I-218): a Glade file with the same name (so it overrides the
 * source) that `extends` it and sets nothing else yet. `inherit`/empty fields mean "the source's".
 */
export function customizeDraft(def: Pick<AgentDef, "source" | "fields">): AgentDefFields {
  return { ...emptyAgentDefFields(INHERIT), name: def.fields.name, extends: `${def.source}:${def.fields.name}` };
}

/** The harness whose settings apply: the file's, else (with `extends`) the source's. */
export function effectiveHarness(fields: Pick<AgentDefFields, "harness">, base: Pick<AgentDefFields, "harness"> | null): string {
  return fields.harness !== INHERIT ? fields.harness : (base?.harness ?? INHERIT);
}
