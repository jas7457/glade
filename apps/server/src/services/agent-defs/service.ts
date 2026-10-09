/**
 * Glade agents (I-218): finds, reads, resolves and writes agent definitions (see
 * `@glade/protocol` `agent-defs.ts` for the format and rules). One instance per server
 * (`AppContext.agentDefs`); the agent team (`services/app/agent-team.ts`) resolves a spawn's
 * `agent` through {@link AgentDefsService.resolve}, Settings uses the REST routes
 * (`http/agent-defs.ts`), and harness sessions report the tools they saw
 * ({@link AgentDefsService.recordTools}).
 *
 * Everything is read fresh on every call (agent files are tiny), so edits in any editor apply to
 * the next list/spawn. The work is in the modules next to this one: `format.ts` (Glade's files),
 * `discover.ts` (Claude Code / Codex / pi files and the folders), `build.ts` (extends, effective
 * fields, availability, one-agent-per-name), `tools-cache.ts`, `switches.ts` (settings), `describe.ts`.
 *
 * CONTRACT (lead, I-218): the method signatures below are shared by the agent-defs worker (who
 * implements this file and the folder around it) and the spawn worker (who calls it). Keep them
 * stable; add, don't change.
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AGENT_COLORS,
  AGENT_ICONS,
  CODEX_SANDBOX_MODES,
  INHERIT,
  MAX_AGENT_DEF_DESCRIPTION,
  MAX_AGENT_DEF_PROMPT,
  MAX_AGENT_NICKNAMES,
  THINKING_LEVELS,
  normalizeAgentDefName,
  type AgentDef,
  type AgentDefFields,
  type AgentDefScope,
  type AgentDefToolsResponse,
  type SaveAgentDefRequest,
} from "@glade/protocol";
import { HttpError } from "../app/errors.js";
import { buildAgents, toolRef, type BuiltAgent } from "./build.js";
import { agentFiles, gladeAgentsDir, loadAll, loadGladeAgent, personalDirs, type DiscoveryRoots } from "./discover.js";
import { harnessLabel } from "./fields.js";
import { serializeGladeAgent } from "./format.js";
import { ToolsCache } from "./tools-cache.js";

/** Where a lookup happens: the chat's project (switches, project agents) and folder. */
export interface AgentDefsScope {
  projectId: string | null;
  /** The chat's folder (project agents: `.agents/agents`, `.claude/agents`, `.codex/agents`, `.pi/agents`). */
  cwd: string | null;
}

/**
 * A definition ready for a spawn: `def.effective` after `extends` and translation, plus the source's
 * harness-native fields Glade doesn't model (passed through when the agent runs on that harness:
 * Claude Code frontmatter keys like `hooks`, `mcpServers`, `skills`, `maxTurns`, `effort`; Codex
 * TOML keys like `mcp_servers`, `model_reasoning_effort`).
 *
 * Added by the agent-defs worker: `pi` (pi frontmatter keys Glade doesn't model, e.g. `requires`).
 * A Glade file's own unknown frontmatter keys land under its effective harness. `effort` /
 * `model_reasoning_effort` are only here when Glade has no thinking level for them (else they are
 * `effective.thinking`).
 */
export interface ResolvedAgentDef {
  def: AgentDef;
  native: { claude?: Record<string, unknown>; codex?: Record<string, unknown>; pi?: Record<string, unknown> };
}

export interface AgentDefsServiceOptions {
  /** Glade's data folder (personal agents in `<dataDir>/agents`). */
  dataDir: string;
  /** Home folder (discovery of `~/.claude/agents`, `~/.codex/agents`, `~/.pi/agent`); injectable for tests. */
  homeDir?: string;
  /**
   * Environment for the tools' folder variables (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
   * `PI_CODING_AGENT_DIR`); default the server's `process.env`. Injectable for tests.
   */
  env?: Record<string, string | undefined>;
  log?: (msg: string) => void;
}

export class AgentDefsService {
  private readonly toolsCache: ToolsCache;

  constructor(readonly options: AgentDefsServiceOptions) {
    this.toolsCache = ToolsCache.inDataDir(options.dataDir, options.log);
  }

  /**
   * Every definition visible in `scope` (Glade's, then discovered), with switches and availability.
   * A customization is listed too, linked to its source (`customizes` / `customizedBy`).
   */
  async list(scope: AgentDefsScope, ctx: AgentDefsListContext): Promise<AgentDef[]> {
    return this.build(scope, ctx).map((b) => b.def);
  }

  /**
   * The enabled, available definition named `name` in `scope` (one agent per name, I-220; a
   * customized agent resolves to its customization). Throws `HttpError(400)` naming the available
   * ones when unknown/unavailable. `name` may also be an id (`claude:code-reviewer`).
   */
  async resolve(name: string, scope: AgentDefsScope, ctx: AgentDefsListContext): Promise<ResolvedAgentDef> {
    const built = this.build(scope, ctx);
    const wanted = name.trim();
    const byId = wanted.includes(":") ? built.find((b) => b.def.id === wanted) : undefined;
    const key = normalizeAgentDefName(wanted);
    // A source with a customization stands aside for it.
    const current = (b: BuiltAgent) => !b.def.customizedBy;
    const used = (b: BuiltAgent | undefined) => (b?.def.customizedBy ? built.find((c) => c.def.id === b.def.customizedBy) : b) ?? b;
    const hit = used(byId) ?? built.find((b) => b.def.fields.name === key && current(b));
    const usable = built.filter((b) => current(b) && b.def.enabled && b.def.available).map((b) => b.def.fields.name);
    const listing = usable.length ? `Available agents: ${[...new Set(usable)].join(", ")}.` : "No agents are available here.";
    if (!hit) throw new HttpError(400, `Unknown agent "${wanted}". ${listing}`);
    if (!hit.def.enabled) throw new HttpError(400, `Agent "${hit.def.fields.name}" is turned off here. ${listing}`);
    if (!hit.def.available) throw new HttpError(400, `Agent "${hit.def.fields.name}" can't run: ${hit.def.problems.join("; ")}. ${listing}`);
    return { def: hit.def, native: hit.native };
  }

  /**
   * Create/replace (rename with `previousName`) a Glade agent file; validates (HttpError 400).
   * One agent per name (I-220, HttpError 409): creating or renaming onto a name another listed
   * agent has is refused, and so is a second customization of one source (any scope). A
   * customization (`extends: <tool>:<name>`) is always named like its source (400 otherwise).
   * `viewDir`: the folder of the project the client is looking at, so a personal save checks that
   * project's agents too.
   */
  async save(req: SaveAgentDefRequest, projectDir: string | null, ctx: AgentDefsListContext, viewDir: string | null = null): Promise<AgentDef> {
    if (req.scope !== "personal" && req.scope !== "project") throw new HttpError(400, 'scope must be "personal" or "project"');
    if (req.scope === "project" && !projectDir) throw new HttpError(400, "Project agents need a project with a folder");
    const fields = validateFields(req.fields);
    const dir = this.dir(req.scope, projectDir);
    const previous = req.previousName !== undefined ? normalizeAgentDefName(String(req.previousName)) : fields.name;
    const existing = previous ? this.findFile(dir, previous) : null;
    if (previous !== fields.name && this.findFile(dir, fields.name)) {
      throw new HttpError(409, `There's already an agent named "${fields.name}" here`);
    }
    this.checkUnique(fields, req.scope, existing ? previous : null, { projectId: req.projectId ?? null, cwd: projectDir ?? viewDir }, ctx, !existing || previous !== fields.name);
    // Keys Glade doesn't know stay as they were written.
    const unknownRaw = existing ? (loadGladeAgent(existing, req.scope, req.scope)?.unknownRaw ?? []) : [];
    const target = existing && previous === fields.name ? existing : join(dir, `${fields.name}.md`);
    writeAtomic(target, serializeGladeAgent(fields, unknownRaw));
    if (existing && existing !== target) unlinkSync(existing);
    const scope: AgentDefsScope = { projectId: req.projectId ?? null, cwd: projectDir ?? viewDir };
    const def = this.build(scope, ctx).find((b) => b.def.id === `${req.scope}:${fields.name}`)?.def;
    if (!def) throw new HttpError(500, "The agent was saved but can't be read back");
    return def;
  }

  /** The 409/400 checks of {@link save}; `ownName`: the file being replaced; `claimsName`: a new or renamed agent. */
  private checkUnique(fields: AgentDefFields, scope: AgentDefScope, ownName: string | null, view: AgentDefsScope, ctx: AgentDefsListContext, claimsName: boolean): void {
    const built = this.build(view, ctx).map((b) => b.def);
    const ownId = ownName ? `${scope}:${ownName}` : null;
    const source = toolRef(fields.extends);
    if (source) {
      const sourceName = source.slice(source.indexOf(":") + 1);
      if (sourceName !== fields.name) throw new HttpError(400, `A customization is named like its source: ${sourceName}`);
      const other = built.find((d) => d.customizes === source && d.id !== ownId);
      if (other) throw new HttpError(409, `${agentSourceLabel(source.slice(0, source.indexOf(":")))}'s ${sourceName} is already customized (${other.id.startsWith("project:") ? "in the project" : "in your settings"}). Edit or reset that one`);
    }
    // Turning a customization into a standalone agent claims the source's name, too.
    if (!claimsName && !(source === null && built.find((d) => d.id === ownId)?.customizes)) return;
    const clash = built.find((d) => d.fields.name === fields.name && !d.customizes && d.id !== ownId && d.id !== source);
    if (!clash) return;
    const by = agentSourceLabel(clash.source);
    throw new HttpError(
      409,
      clash.editable ? `Glade already has an agent named ${fields.name} (${clash.path})` : `${by} already has an agent named ${fields.name} — customize it instead`,
    );
  }

  /** Delete a Glade agent file (for a customization: reset it to the original). */
  async remove(scope: AgentDefScope, name: string, projectDir: string | null): Promise<void> {
    if (scope !== "personal" && scope !== "project") throw new HttpError(400, 'scope must be "personal" or "project"');
    if (scope === "project" && !projectDir) throw new HttpError(400, "Project agents need a project with a folder");
    const file = this.findFile(this.dir(scope, projectDir), normalizeAgentDefName(name));
    if (!file) throw new HttpError(404, `No ${scope} agent named "${name}"`);
    unlinkSync(file);
  }

  /** A harness session saw these tools (pi: `getAllTools()`; Claude Code: init `tools`/`mcp_servers`). */
  recordTools(harness: string, projectId: string | null, tools: string[], mcpServers: string[]): void {
    this.toolsCache.record(harness, projectId, tools, mcpServers);
  }

  /** The tools last seen for `harness` in `projectId` (falls back to any project's). */
  tools(harness: string, projectId: string | null): AgentDefToolsResponse {
    return this.toolsCache.get(harness, projectId);
  }

  /** Write pending tool lists now (shutdown, tests). */
  flush(): void {
    this.toolsCache.flush();
  }

  /** Folder of a scope's Glade agents. */
  dir(scope: AgentDefScope, projectDir: string | null): string {
    return scope === "personal" ? gladeAgentsDir("personal", this.options.dataDir) : gladeAgentsDir("project", projectDir!);
  }

  private roots(cwd: string | null): DiscoveryRoots {
    const home = this.options.homeDir ?? homedir();
    return { home, cwd, dataDir: this.options.dataDir, dirs: personalDirs(home, this.options.env ?? process.env) };
  }

  private build(scope: AgentDefsScope, ctx: AgentDefsListContext): BuiltAgent[] {
    const roots = this.roots(scope.cwd);
    return buildAgents(loadAll(roots), { roots, projectId: scope.projectId, switches: ctx.switches, offeredHarnesses: ctx.offeredHarnesses });
  }

  /** The file in `dir` holding agent `name` (`<name>.md`, else a file whose frontmatter names it). */
  private findFile(dir: string, name: string): string | null {
    const files = agentFiles(dir, ".md");
    const direct = join(dir, `${name}.md`);
    if (files.includes(direct) && loadGladeAgent(direct, "personal", "personal")?.fields.name === name) return direct;
    return files.find((f) => loadGladeAgent(f, "personal", "personal")?.fields.name === name) ?? null;
  }
}

/** "Glade" for Glade's own sources, else the tool's name. */
function agentSourceLabel(source: string): string {
  return source === "personal" || source === "project" ? "Glade" : harnessLabel(source);
}

/** What `list`/`resolve` need from the server to fill `enabled`/`available`/`problems`. */
export interface AgentDefsListContext {
  /** Settings' on/off switches. */
  switches: import("@glade/protocol").AgentDefSwitches;
  /** Harness ids this device offers right now (installed and on). */
  offeredHarnesses: string[];
}

/** `fields` from a client, checked and normalised (HttpError 400 with the reason). */
export function validateFields(input: unknown): AgentDefFields {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new HttpError(400, "fields must be an object");
  const f = input as Record<string, unknown>;
  const str = (key: string, max = 1_000): string => {
    const v = f[key];
    if (v === undefined || v === null) return "";
    if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
    if (v.length > max) throw new HttpError(400, `${key} is too long (max ${max} characters)`);
    return v.trim();
  };
  const optional = (key: string): string | null => str(key) || null;
  const list = (key: string): string[] | null => {
    const v = f[key];
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v) || v.some((t) => typeof t !== "string")) throw new HttpError(400, `${key} must be a list of names`);
    return [...new Set((v as string[]).map((t) => t.trim()).filter(Boolean))];
  };
  const name = normalizeAgentDefName(str("name", 200));
  if (!name) throw new HttpError(400, "name is required (letters, digits, dashes)");
  const harness = (str("harness") || INHERIT).toLowerCase();
  if (harness !== INHERIT && !/^[a-z0-9][a-z0-9._-]*$/.test(harness)) throw new HttpError(400, `unknown harness "${harness}"`);
  const model = str("model") || INHERIT;
  const ext = optional("extends");
  if (model !== INHERIT && harness === INHERIT && !ext) throw new HttpError(400, "A specific model needs a specific harness");
  const thinking = str("thinking") || INHERIT;
  if (thinking !== INHERIT && !(THINKING_LEVELS as readonly string[]).includes(thinking)) throw new HttpError(400, `unknown thinking level "${thinking}"`);
  const color = optional("color");
  if (color && !(AGENT_COLORS as readonly string[]).includes(color)) throw new HttpError(400, `unknown color "${color}"`);
  const icon = optional("icon");
  if (icon && !(AGENT_ICONS as readonly string[]).includes(icon)) throw new HttpError(400, `unknown icon "${icon}"`);
  const sandbox = optional("sandbox");
  if (sandbox && !(CODEX_SANDBOX_MODES as readonly string[]).includes(sandbox)) throw new HttpError(400, `unknown sandbox mode "${sandbox}"`);
  const nicknames = list("nicknames") ?? [];
  if (nicknames.length > MAX_AGENT_NICKNAMES) throw new HttpError(400, `At most ${MAX_AGENT_NICKNAMES} nicknames`);
  if (nicknames.some((n) => n.length > 40)) throw new HttpError(400, "Nicknames are at most 40 characters");
  return {
    name,
    description: str("description", MAX_AGENT_DEF_DESCRIPTION),
    harness,
    model,
    thinking: thinking as AgentDefFields["thinking"],
    extends: ext,
    nicknames,
    color: color as AgentDefFields["color"],
    icon: icon as AgentDefFields["icon"],
    tools: list("tools"),
    disallowedTools: list("disallowedTools"),
    permissionMode: optional("permissionMode"),
    sandbox: sandbox as AgentDefFields["sandbox"],
    prompt: str("prompt", MAX_AGENT_DEF_PROMPT),
  };
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
