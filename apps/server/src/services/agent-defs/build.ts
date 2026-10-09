/**
 * From agent files to {@link AgentDef}s (I-218): `extends` (one level or a chain of Glade files,
 * loops refused), the effective fields a spawn uses, availability and problems, switches and
 * shadowing (same name: project Glade > personal Glade > Claude Code > Codex > pi, as loaded).
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

/** Every loaded agent as an {@link AgentDef}, with its native settings, in precedence order. */
export function buildAgents(loaded: LoadedAgent[], options: BuildOptions): BuiltAgent[] {
  const winners = new Map<string, string>();
  return loaded.map((agent) => {
    const id = `${agent.source}:${agent.fields.name}`;
    const effective = effectiveOf(agent, options.roots, 0, new Set());
    check(effective, options.offeredHarnesses);
    const winner = winners.get(agent.fields.name);
    if (!winner) winners.set(agent.fields.name, id);
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
      shadowedBy: winner ?? null,
    };
    return { def, native: effective.native };
  });
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
