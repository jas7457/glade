/**
 * From agent files to {@link AgentDef}s (I-218): `extends` (one level or a chain of Glade files,
 * loops refused), the effective fields a spawn uses, availability and problems, switches, and the
 * one-agent-per-name rule with customizations (I-220).
 *
 * Merge rules for `extends`: the Glade file's fields win when set (not inherit/null/[]/""), so its
 * `inherit` harness/model/thinking mean the source's (lead decision); its body is appended to the
 * source's prompt (blank line between); a source model, tools, … for another harness are dropped
 * (with a warning) when the Glade file switches harness;
 * nicknames, colour and icon only come from the Glade file.
 */
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { INHERIT, agentDefEnabled, normalizeAgentDefName, type AgentDef, type AgentDefFields, type AgentDefSource, type AgentDefSwitches } from "@glade/protocol";
import { findDiscovered, loadAgentFile, type DiscoveryRoots, type LoadedAgent } from "./discover.js";
import { CLAUDE, CODEX, PI, gladeModel, harnessLabel, modelHarnessMismatch } from "./fields.js";

/** Harness-native settings Glade passes through (see `ResolvedAgentDef.native`). */
export type NativeByHarness = Partial<Record<string, Record<string, unknown>>>;

export interface BuildOptions {
  roots: DiscoveryRoots;
  projectId: string | null;
  switches: AgentDefSwitches;
  offeredHarnesses: string[];
  /** I-221: `Settings.agent.subagentOtherHarnesses` / `subagentOtherModels`; absent = on (no notes). */
  otherHarnesses?: boolean;
  otherModels?: boolean;
}

export interface BuiltAgent {
  def: AgentDef;
  native: NativeByHarness;
}

interface Effective {
  fields: AgentDefFields;
  /** The `extends` source's effective fields (`AgentDef.base`); null without one. */
  base: AgentDefFields | null;
  native: NativeByHarness;
  errors: string[];
  warnings: string[];
}

const GLADE_SOURCES = new Set<AgentDefSource>(["personal", "project"]);
const TOOL_REF = /^(claude|codex|pi):(.+)$/;
const MAX_EXTENDS_DEPTH = 4;

/**
 * Every loaded agent as an {@link AgentDef}, with its native settings (precedence order of the
 * files within a source). One agent per name (I-220): a Glade file named like its source that
 * extends it is that source's customization (not a second agent); any other two agents with one
 * name are both unavailable.
 */
export function buildAgents(loaded: LoadedAgent[], options: BuildOptions): BuiltAgent[] {
  const ids = loaded.map((agent) => `${agent.source}:${agent.fields.name}`);
  const known = new Set(ids);
  // Customizations by their source's id (project file first, as loaded).
  const customizations = new Map<string, string[]>();
  const customizes = new Map<string, string>();
  loaded.forEach((agent, i) => {
    const source = customizationSource(agent);
    if (!source || !known.has(source)) return;
    customizes.set(ids[i]!, source);
    customizations.set(source, [...(customizations.get(source) ?? []), ids[i]!]);
  });
  // Problems that make an agent unusable from outside its own file.
  const extraErrors = new Map<string, string[]>();
  const addError = (id: string, message: string) => extraErrors.set(id, [...(extraErrors.get(id) ?? []), message]);
  for (const [source, files] of customizations) {
    if (files.length < 2) continue;
    const where = files.map((id) => (id.startsWith("project:") ? "the project" : "your settings")).join(" and ");
    for (const id of [source, ...files]) addError(id, `Customized in ${where}; reset one to the original`);
  }
  // One agent per name: customizations belong to their source's entry.
  const byName = new Map<string, string[]>();
  loaded.forEach((agent, i) => {
    if (customizes.has(ids[i]!)) return;
    byName.set(agent.fields.name, [...(byName.get(agent.fields.name) ?? []), ids[i]!]);
  });
  for (const [name, entries] of byName) {
    if (entries.length < 2) continue;
    const message = entries.length === 2 ? `Two agents are named ${name}; rename one` : `${entries.length} agents are named ${name}; rename all but one`;
    for (const id of entries) for (const own of [id, ...(customizations.get(id) ?? [])]) addError(own, message);
  }
  return loaded.map((agent, i) => {
    const id = ids[i]!;
    const effective = effectiveOf(agent, options.roots, 0, new Set());
    effective.errors.push(...(extraErrors.get(id) ?? []));
    check(effective, options.offeredHarnesses);
    if (effective.errors.length === 0) switchNotes(effective, options); // notes only on agents that can run
    const def: AgentDef = {
      id,
      source: agent.source,
      path: displayPath(agent.path, options.roots.home),
      editable: GLADE_SOURCES.has(agent.source),
      fields: agent.fields,
      effective: effective.fields,
      base: effective.base,
      enabled: agentDefEnabled(options.switches, agent.fields.name, options.projectId),
      available: effective.errors.length === 0,
      problems: [...new Set([...effective.errors, ...effective.warnings])],
      customizes: customizes.get(id) ?? null,
      customizedBy: customizations.get(id)?.[0] ?? null,
    };
    return { def, native: effective.native };
  });
}

/** The tool agent `ref` (`claude:x`) names, as `<tool>:<name>`; null for file paths. */
export function toolRef(ref: string | null): string | null {
  const tool = ref ? TOOL_REF.exec(ref.trim()) : null;
  return tool ? `${tool[1]}:${normalizeAgentDefName(tool[2]!)}` : null;
}

/**
 * The id of the agent a Glade file customizes: it `extends: <tool>:<name>` and is itself named
 * `name` (I-220). Null for other files (a different name is a separate agent that extends).
 */
export function customizationSource(agent: Pick<LoadedAgent, "source" | "fields">): string | null {
  if (!GLADE_SOURCES.has(agent.source)) return null;
  const ref = toolRef(agent.fields.extends);
  return ref && ref.endsWith(`:${agent.fields.name}`) ? ref : null;
}

/** `~/…` for paths in the home folder. */
export function displayPath(path: string, home: string): string {
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

function effectiveOf(agent: LoadedAgent, roots: DiscoveryRoots, depth: number, seen: Set<string>): Effective {
  const errors = [...agent.errors];
  const warnings = [...agent.warnings];
  if (!GLADE_SOURCES.has(agent.source)) {
    const native: NativeByHarness = Object.keys(agent.native).length ? { [agent.source]: agent.native } : {};
    return { fields: agent.fields, base: null, native, errors, warnings };
  }
  const own = agent.fields;
  seen.add(agent.path);
  let source: Effective | null = null;
  if (own.extends) {
    const found = findSource(own.extends, agent.path, roots);
    if (!found) errors.push(`source not found: ${own.extends}`);
    else if (seen.has(found.path) || depth >= MAX_EXTENDS_DEPTH) errors.push(`extends loops back: ${own.extends}`);
    else {
      source = effectiveOf(found, roots, depth + 1, seen);
      errors.push(...source.errors.map((e) => `${own.extends}: ${e}`));
      warnings.push(...source.warnings.map((w) => `${own.extends}: ${w}`));
    }
  }
  const fields = source ? merge(source.fields, own, own.extends!, warnings) : { ...own };
  if (fields.harness !== INHERIT) fields.model = gladeModel(fields.harness, fields.model);
  const native: NativeByHarness = { ...(source?.native ?? {}) };
  // Keys Glade doesn't know in a Glade file: the effective harness's own settings (e.g. Claude
  // Code's `hooks` or `mcpServers`).
  const unknown = Object.keys(agent.native);
  if (unknown.length) {
    if ([CLAUDE, CODEX, PI].includes(fields.harness)) native[fields.harness] = { ...(native[fields.harness] ?? {}), ...agent.native };
    else warnings.push(`fields not used without a harness: ${unknown.join(", ")}`);
  }
  return { fields, base: source ? source.fields : null, native, errors, warnings };
}

function merge(source: AgentDefFields, own: AgentDefFields, ref: string, warnings: string[]): AgentDefFields {
  const harness = own.harness !== INHERIT ? own.harness : source.harness;
  const same = harness === source.harness;
  const dropped: string[] = [];
  if (own.model === INHERIT && !same && source.model !== INHERIT) dropped.push("model");
  const keep = <K extends "tools" | "disallowedTools" | "permissionMode" | "sandbox">(key: K): AgentDefFields[K] => {
    const mine = own[key];
    if (mine !== null && !(Array.isArray(mine) && mine.length === 0)) return mine;
    if (source[key] === null) return null;
    if (same) return source[key];
    dropped.push(key);
    return null;
  };
  const fields: AgentDefFields = {
    name: own.name,
    description: own.description || source.description,
    harness,
    model: own.model !== INHERIT ? own.model : same ? source.model : INHERIT,
    thinking: own.thinking !== INHERIT ? own.thinking : source.thinking,
    extends: own.extends,
    nicknames: own.nicknames,
    color: own.color,
    icon: own.icon,
    tools: keep("tools"),
    disallowedTools: keep("disallowedTools"),
    permissionMode: keep("permissionMode"),
    sandbox: keep("sandbox"),
    prompt: [source.prompt.trim(), own.prompt.trim()].filter(Boolean).join("\n\n"),
  };
  if (dropped.length) warnings.push(`${ref}'s ${dropped.join(", ")} not used on ${harnessLabel(harness)}`);
  return fields;
}

/** The agent `ref` names: `claude:x` / `codex:x` / `pi:x`, or a file path (`~`, relative to `from`'s folder). */
function findSource(ref: string, from: string, roots: DiscoveryRoots): LoadedAgent | null {
  const tool = TOOL_REF.exec(ref);
  if (tool) return findDiscovered(roots, tool[1] as AgentDefSource, normalizeAgentDefName(tool[2]!));
  const home = roots.home || homedir();
  const expanded = ref === "~" ? home : ref.startsWith("~/") ? join(home, ref.slice(2)) : ref;
  const path = isAbsolute(expanded) ? expanded : resolvePath(dirname(from), expanded);
  return loadAgentFile(path);
}

/**
 * I-221: warnings (not errors: the agent still works for chats of its own harness) when Settings →
 * Sub-agents turns other agents / other models off, and this agent pins one.
 */
function switchNotes(effective: Effective, options: Pick<BuildOptions, "otherHarnesses" | "otherModels">): void {
  const { harness, model, thinking } = effective.fields;
  if (options.otherHarnesses === false && harness !== INHERIT) {
    const label = harnessLabel(harness);
    effective.warnings.push(`Runs on ${label}; other agents are off for sub-agents (only used by ${label} chats)`);
  }
  if (options.otherModels === false && (model !== INHERIT || thinking !== INHERIT)) {
    effective.warnings.push(`Uses the chat's ${model !== INHERIT && thinking !== INHERIT ? "model and thinking" : model !== INHERIT ? "model" : "thinking"} (other models are off)`);
  }
}

/** Availability errors and harness-applicability warnings on the effective fields. */
function check(effective: Effective, offered: string[]): void {
  const { fields, errors, warnings, native } = effective;
  const { harness } = fields;
  if (harness !== INHERIT && !/^[a-z0-9][a-z0-9._-]*$/.test(harness)) {
    errors.push(`unknown harness "${harness}"`);
    return;
  }
  if (fields.model !== INHERIT && harness === INHERIT) errors.push(`model "${fields.model}" needs a harness (harness: inherit)`);
  if (harness === INHERIT) return;
  if (!offered.includes(harness)) errors.push(`${harnessLabel(harness)} is turned off or not installed`);
  const mismatch = modelHarnessMismatch(harness, fields.model);
  if (mismatch) errors.push(mismatch);
  const label = harnessLabel(harness);
  if (fields.tools !== null && harness === CODEX) warnings.push(`tools aren't used on ${label}`);
  if (fields.disallowedTools !== null && harness !== CLAUDE) warnings.push(`disallowedTools only apply on Claude Code`);
  if (fields.permissionMode !== null && harness !== CLAUDE) warnings.push(`permissionMode only applies on Claude Code`);
  if (fields.sandbox !== null && harness !== CODEX) warnings.push(`sandbox only applies on Codex`);
  for (const [owner, settings] of Object.entries(native)) {
    const keys = Object.keys(settings ?? {});
    if (owner !== harness && keys.length) warnings.push(`${harnessLabel(owner)} settings not used on ${label}: ${keys.join(", ")}`);
  }
}
