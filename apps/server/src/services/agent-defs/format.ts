/**
 * Glade's agent file format (I-218): Markdown with YAML frontmatter ↔ {@link AgentDefFields}. See
 * `@glade/protocol` `agent-defs.ts` for the fields. Reading is lenient (bad values become problems
 * and fall back to inherit/unset); writing is deterministic (fixed key order, inherit/empty values
 * left out) and keeps keys Glade doesn't know as they were written.
 */
import {
  AGENT_COLORS,
  AGENT_ICONS,
  CODEX_SANDBOX_MODES,
  INHERIT,
  MAX_AGENT_NICKNAMES,
  emptyAgentDefFields,
  normalizeAgentDefName,
  type AgentColor,
  type AgentDefFields,
  type AgentIcon,
  type CodexSandboxMode,
} from "@glade/protocol";
import { readList, readString, readThinking, splitFrontmatter } from "./fields.js";
import { parseYaml, splitTopLevel, yamlFlowList, yamlString } from "./yaml-lite.js";

/** Frontmatter keys Glade reads (`nicknames` is accepted for `nickname`). */
export const GLADE_KEYS = [
  "name",
  "description",
  "harness",
  "model",
  "thinking",
  "extends",
  "nickname",
  "nicknames",
  "color",
  "icon",
  "tools",
  "disallowedTools",
  "permissionMode",
  "sandbox",
] as const;

export interface ParsedGladeAgent {
  fields: AgentDefFields;
  /** The frontmatter can't be read (the agent can't be used). */
  errors: string[];
  /** Values that were ignored. */
  warnings: string[];
  /** Keys Glade doesn't know, parsed (handed to the harness as native settings). */
  unknown: Record<string, unknown>;
  /** The same keys' raw text, written back unchanged on save. */
  unknownRaw: string[];
}

/** Read a Glade agent file; `fallbackName` (the file name) is used when it has no `name`. */
export function parseGladeAgent(text: string, fallbackName: string): ParsedGladeAgent {
  const { frontmatter, body } = splitFrontmatter(text);
  const fields = emptyAgentDefFields();
  const errors: string[] = [];
  const warnings: string[] = [];
  const unknown: Record<string, unknown> = {};
  const unknownRaw: string[] = [];
  let meta: Record<string, unknown> = {};
  if (frontmatter !== null) {
    try {
      meta = parseYaml(frontmatter);
    } catch (err) {
      errors.push(`can't read the frontmatter: ${(err as Error).message}`);
    }
    const known = new Set<string>(GLADE_KEYS);
    for (const entry of splitTopLevel(frontmatter)) {
      if (!known.has(entry.key)) {
        unknownRaw.push(entry.raw);
        if (entry.key in meta) unknown[entry.key] = meta[entry.key];
      }
    }
  }
  fields.name = normalizeAgentDefName(readString(meta.name) ?? fallbackName) || normalizeAgentDefName(fallbackName);
  fields.description = readString(meta.description) ?? "";
  const harness = readString(meta.harness)?.toLowerCase();
  if (harness) fields.harness = harness;
  fields.model = readString(meta.model) ?? INHERIT;
  const thinking = readString(meta.thinking);
  const level = readThinking(thinking);
  if (level) fields.thinking = level;
  else warnings.push(`unknown thinking level "${thinking}"`);
  fields.extends = readString(meta.extends);
  fields.nicknames = (readList(meta.nickname ?? meta.nicknames) ?? []).slice(0, MAX_AGENT_NICKNAMES);
  const color = readString(meta.color);
  if (color && (AGENT_COLORS as readonly string[]).includes(color)) fields.color = color as AgentColor;
  else if (color) warnings.push(`unknown color "${color}"`);
  const icon = readString(meta.icon);
  if (icon && (AGENT_ICONS as readonly string[]).includes(icon)) fields.icon = icon as AgentIcon;
  else if (icon) warnings.push(`unknown icon "${icon}"`);
  fields.tools = readList(meta.tools);
  fields.disallowedTools = readList(meta.disallowedTools);
  fields.permissionMode = readString(meta.permissionMode);
  const sandbox = readString(meta.sandbox);
  if (sandbox && (CODEX_SANDBOX_MODES as readonly string[]).includes(sandbox)) fields.sandbox = sandbox as CodexSandboxMode;
  else if (sandbox) warnings.push(`unknown sandbox mode "${sandbox}"`);
  fields.prompt = body.trim();
  return { fields, errors, warnings, unknown, unknownRaw };
}

/** The file for `fields` (plus unknown keys' raw text, kept from the file being replaced). */
export function serializeGladeAgent(fields: AgentDefFields, unknownRaw: string[] = []): string {
  const lines: string[] = [`name: ${yamlString(fields.name)}`];
  const add = (key: string, value: string | null | undefined) => {
    if (value && value !== INHERIT) lines.push(`${key}: ${yamlString(value)}`);
  };
  add("description", fields.description.trim());
  add("harness", fields.harness);
  add("model", fields.model);
  add("thinking", fields.thinking);
  add("extends", fields.extends);
  const nicknames = fields.nicknames.map((n) => n.trim()).filter(Boolean);
  if (nicknames.length === 1) lines.push(`nickname: ${yamlString(nicknames[0]!)}`);
  else if (nicknames.length > 1) lines.push(`nickname: ${yamlFlowList(nicknames)}`);
  add("color", fields.color);
  add("icon", fields.icon);
  for (const key of ["tools", "disallowedTools"] as const) {
    const list = fields[key];
    if (!list) continue;
    // Claude Code's `Read, Grep, Glob` unless a name has a comma (or none: an explicit empty list).
    if (!list.length) lines.push(`${key}: []`);
    else if (list.some((t) => t.includes(","))) lines.push(`${key}: ${yamlFlowList(list)}`);
    else lines.push(`${key}: ${yamlString(list.join(", "))}`);
  }
  add("permissionMode", fields.permissionMode);
  add("sandbox", fields.sandbox);
  lines.push(...unknownRaw);
  const prompt = fields.prompt.trim();
  return `---\n${lines.join("\n")}\n---\n${prompt ? `${prompt}\n` : ""}`;
}
