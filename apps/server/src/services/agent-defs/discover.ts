/**
 * Discovered agents (I-218): other tools' agent files, read live and never written.
 *
 *   Claude Code  `<cwd>/.claude/agents/*.md`, `~/.claude/agents/*.md` (YAML frontmatter + prompt)
 *   Codex        `<cwd>/.codex/agents/*.toml`, `~/.codex/agents/*.toml`
 *   pi           `<cwd>/.pi/agents/*.md`, `~/.pi/agent/agents/*.md`, pi packages' `agents/`
 *
 * The personal folders follow the tools' own variables, like the tools do: `CLAUDE_CONFIG_DIR`
 * (instead of `~/.claude`), `CODEX_HOME` (`~/.codex`), `PI_CODING_AGENT_DIR` (`~/.pi/agent`); see
 * {@link personalDirs}.
 *
 * Each becomes Glade's fields on its own harness (models as Glade's `provider/id`, efforts as
 * thinking levels); keys Glade doesn't model are kept as the harness's native settings.
 * Also the Glade folders (`<data>/agents`, `<cwd>/.agents/agents`) are listed here.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  AGENT_COLORS,
  CODEX_SANDBOX_MODES,
  MAX_AGENT_NICKNAMES,
  emptyAgentDefFields,
  normalizeAgentDefName,
  type AgentColor,
  type AgentDefFields,
  type AgentDefSource,
  type CodexSandboxMode,
} from "@glade/protocol";
import { packageAgentDirs } from "../../harness/pi/extension/glade-tools.js";
import { CLAUDE, CODEX, PI, gladeModel, readList, readString, readThinking, splitFrontmatter } from "./fields.js";
import { parseGladeAgent } from "./format.js";
import { parseToml } from "./toml-lite.js";
import { parseYaml } from "./yaml-lite.js";

/** Where in its tool's locations an agent file was found. */
export type AgentLocation = "project" | "personal" | "package";

/** One agent file, read. */
export interface LoadedAgent {
  source: AgentDefSource;
  location: AgentLocation;
  /** Absolute path. */
  path: string;
  fields: AgentDefFields;
  /** Settings Glade doesn't model, for the harness they belong to (discovered agents) or unknown keys (Glade's). */
  native: Record<string, unknown>;
  /** Make the agent unusable (e.g. unreadable file). */
  errors: string[];
  warnings: string[];
  /** Glade's own files: unknown keys' raw text (kept on save). */
  unknownRaw?: string[];
}

/** Agent files in `dir` with `ext`, sorted by name (missing folder = none). */
export function agentFiles(dir: string, ext: ".md" | ".toml"): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => extname(n) === ext && !n.startsWith("."))
    .sort()
    .map((n) => join(dir, n));
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function fileName(path: string): string {
  return basename(path, extname(path));
}

function unreadable(source: AgentDefSource, location: AgentLocation, path: string, harness: string, message: string): LoadedAgent {
  return { source, location, path, fields: { ...emptyAgentDefFields(harness), name: normalizeAgentDefName(fileName(path)) }, native: {}, errors: [message], warnings: [] };
}

// ---------------------------------------------------------------------------------------------
// Glade
// ---------------------------------------------------------------------------------------------

/** A Glade agent file (`personal` or `project`). */
export function loadGladeAgent(path: string, source: AgentDefSource, location: AgentLocation): LoadedAgent | null {
  const text = readText(path);
  if (text === null) return null;
  const parsed = parseGladeAgent(text, fileName(path));
  return { source, location, path, fields: parsed.fields, native: parsed.unknown, errors: parsed.errors, warnings: parsed.warnings, unknownRaw: parsed.unknownRaw };
}

// ---------------------------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------------------------

const CLAUDE_MAPPED = new Set(["name", "description", "tools", "disallowedTools", "model", "permissionMode", "color"]);

/** A Claude Code subagent file (`.claude/agents/*.md`). */
export function loadClaudeAgent(path: string, location: AgentLocation): LoadedAgent | null {
  const text = readText(path);
  if (text === null) return null;
  const { frontmatter, body } = splitFrontmatter(text);
  let meta: Record<string, unknown>;
  try {
    meta = frontmatter === null ? {} : parseYaml(frontmatter);
  } catch (err) {
    return unreadable(CLAUDE, location, path, CLAUDE, `can't read the frontmatter: ${(err as Error).message}`);
  }
  const fields = emptyAgentDefFields(CLAUDE);
  const warnings: string[] = [];
  fields.name = normalizeAgentDefName(readString(meta.name) ?? fileName(path)) || normalizeAgentDefName(fileName(path));
  fields.description = readString(meta.description) ?? "";
  fields.model = gladeModel(CLAUDE, readString(meta.model));
  fields.tools = readList(meta.tools);
  fields.disallowedTools = readList(meta.disallowedTools);
  fields.permissionMode = readString(meta.permissionMode);
  // Claude Code's colours (red, blue, …) only where Glade has the same name.
  const color = readString(meta.color);
  if (color && (AGENT_COLORS as readonly string[]).includes(color)) fields.color = color as AgentColor;
  const native: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) if (!CLAUDE_MAPPED.has(key)) native[key] = value;
  // `effort` is Claude Code's thinking; kept native too when Glade has no level for it.
  const effort = readString(meta.effort);
  const level = effort ? readThinking(effort) : null;
  if (level) {
    fields.thinking = level;
    delete native.effort;
  }
  fields.prompt = body.trim();
  return { source: CLAUDE, location, path, fields, native, errors: [], warnings };
}

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------

const CODEX_MAPPED = new Set(["name", "description", "developer_instructions", "model", "model_reasoning_effort", "sandbox_mode", "nickname_candidates"]);

/** A Codex custom agent file (`.codex/agents/*.toml`). */
export function loadCodexAgent(path: string, location: AgentLocation): LoadedAgent | null {
  const text = readText(path);
  if (text === null) return null;
  let data: Record<string, unknown>;
  try {
    data = parseToml(text);
  } catch (err) {
    return unreadable(CODEX, location, path, CODEX, `can't read the file: ${(err as Error).message}`);
  }
  const fields = emptyAgentDefFields(CODEX);
  const warnings: string[] = [];
  fields.name = normalizeAgentDefName(readString(data.name) ?? fileName(path)) || normalizeAgentDefName(fileName(path));
  fields.description = readString(data.description) ?? "";
  fields.prompt = typeof data.developer_instructions === "string" ? data.developer_instructions.trim() : "";
  fields.model = gladeModel(CODEX, readString(data.model));
  const native: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) if (!CODEX_MAPPED.has(key)) native[key] = value;
  const effort = readString(data.model_reasoning_effort);
  if (effort) {
    const level = readThinking(effort);
    if (level) fields.thinking = level;
    else native.model_reasoning_effort = data.model_reasoning_effort;
  }
  const sandbox = readString(data.sandbox_mode);
  if (sandbox && (CODEX_SANDBOX_MODES as readonly string[]).includes(sandbox)) fields.sandbox = sandbox as CodexSandboxMode;
  else if (sandbox) warnings.push(`unknown sandbox mode "${sandbox}"`);
  fields.nicknames = (readList(data.nickname_candidates) ?? []).slice(0, MAX_AGENT_NICKNAMES);
  return { source: CODEX, location, path, fields, native, errors: [], warnings };
}

// ---------------------------------------------------------------------------------------------
// pi
// ---------------------------------------------------------------------------------------------

const PI_MAPPED = new Set(["name", "description", "model", "thinking", "tools"]);

/** pi's own reading: one `key: value` per line (like ext-kit's agent-teams). */
function piLineMeta(frontmatter: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim();
  }
  return meta;
}

/** A pi agent definition (Markdown with frontmatter: name, description, model, thinking, tools, requires). */
export function loadPiAgent(path: string, location: AgentLocation): LoadedAgent | null {
  const text = readText(path);
  if (text === null) return null;
  const { frontmatter, body } = splitFrontmatter(text);
  let meta: Record<string, unknown> = {};
  if (frontmatter !== null) {
    try {
      meta = parseYaml(frontmatter);
    } catch {
      meta = piLineMeta(frontmatter);
    }
  }
  const fields = emptyAgentDefFields(PI);
  const warnings: string[] = [];
  fields.name = normalizeAgentDefName(readString(meta.name) ?? fileName(path)) || normalizeAgentDefName(fileName(path));
  fields.description = readString(meta.description) ?? "";
  fields.model = gladeModel(PI, readString(meta.model));
  const thinking = readString(meta.thinking);
  const level = readThinking(thinking);
  if (level) fields.thinking = level;
  else warnings.push(`unknown thinking level "${thinking}"`);
  fields.tools = readList(meta.tools);
  const native: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) if (!PI_MAPPED.has(key)) native[key] = value;
  fields.prompt = body.trim();
  return { source: PI, location, path, fields, native, errors: [], warnings };
}

// ---------------------------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------------------------

export interface DiscoveryRoots {
  home: string;
  /** The chat's / project's folder (`null`: personal locations only). */
  cwd: string | null;
  /** Glade's data folder. */
  dataDir: string;
  /** The tools' personal folders (default {@link personalDirs} of `home` and no variables). */
  dirs?: PersonalDirs;
}

/** Claude Code's config folder, Codex's home and pi's agent folder. */
export interface PersonalDirs {
  claude: string;
  codex: string;
  pi: string;
}

/**
 * The tools' personal folders as they resolve them: `CLAUDE_CONFIG_DIR` else `~/.claude`,
 * `CODEX_HOME` else `~/.codex`, `PI_CODING_AGENT_DIR` else `~/.pi/agent` (`~` expanded).
 */
export function personalDirs(home: string, env: Record<string, string | undefined> = {}): PersonalDirs {
  const pick = (name: string, fallback: string) => {
    const value = env[name]?.trim();
    if (!value) return fallback;
    if (value === "~") return home;
    return value.startsWith("~/") ? join(home, value.slice(2)) : value;
  };
  return {
    claude: pick("CLAUDE_CONFIG_DIR", join(home, ".claude")),
    codex: pick("CODEX_HOME", join(home, ".codex")),
    pi: pick("PI_CODING_AGENT_DIR", join(home, ".pi", "agent")),
  };
}

/** Glade's folders: personal `<data>/agents`, project `<cwd>/.agents/agents`. */
export function gladeAgentsDir(scope: "personal" | "project", dataDirOrProject: string): string {
  return scope === "personal" ? join(dataDirOrProject, "agents") : join(dataDirOrProject, ".agents", "agents");
}

type Loader = (path: string, location: AgentLocation) => LoadedAgent | null;

interface Location {
  source: AgentDefSource;
  location: AgentLocation;
  dir: string;
  ext: ".md" | ".toml";
  load: Loader;
}

/** Every location in precedence order (earlier wins for the same name). */
export function locations(roots: DiscoveryRoots): Location[] {
  const { home, cwd, dataDir } = roots;
  const dirs = roots.dirs ?? personalDirs(home);
  const glade = (source: "personal" | "project"): Loader => (path, location) => loadGladeAgent(path, source, location);
  const piDir = dirs.pi;
  const out: Location[] = [];
  if (cwd) out.push({ source: "project", location: "project", dir: gladeAgentsDir("project", cwd), ext: ".md", load: glade("project") });
  out.push({ source: "personal", location: "personal", dir: gladeAgentsDir("personal", dataDir), ext: ".md", load: glade("personal") });
  if (cwd) out.push({ source: CLAUDE, location: "project", dir: join(cwd, ".claude", "agents"), ext: ".md", load: loadClaudeAgent });
  out.push({ source: CLAUDE, location: "personal", dir: join(dirs.claude, "agents"), ext: ".md", load: loadClaudeAgent });
  if (cwd) out.push({ source: CODEX, location: "project", dir: join(cwd, ".codex", "agents"), ext: ".toml", load: loadCodexAgent });
  out.push({ source: CODEX, location: "personal", dir: join(dirs.codex, "agents"), ext: ".toml", load: loadCodexAgent });
  if (cwd) out.push({ source: PI, location: "project", dir: join(cwd, ".pi", "agents"), ext: ".md", load: loadPiAgent });
  out.push({ source: PI, location: "personal", dir: join(piDir, "agents"), ext: ".md", load: loadPiAgent });
  // pi loads packages first and lets later folders win, so packages come last here.
  for (const dir of packageAgentDirs(piDir).reverse()) out.push({ source: PI, location: "package", dir, ext: ".md", load: loadPiAgent });
  return out;
}

/**
 * Every agent file in precedence order. Within one source only the first of a name is kept (the
 * tool itself uses that one: project over personal over packages), so `<source>:<name>` is unique.
 */
export function loadAll(roots: DiscoveryRoots): LoadedAgent[] {
  const seen = new Set<string>();
  const out: LoadedAgent[] = [];
  for (const loc of locations(roots)) {
    for (const path of agentFiles(loc.dir, loc.ext)) {
      const agent = loc.load(path, loc.location);
      if (!agent || !agent.fields.name) continue;
      const key = `${agent.source}:${agent.fields.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(agent);
    }
  }
  return out;
}

/** The `<tool>` agent named `name` (`claude:x`, …): its project location first, then personal (and pi packages). */
export function findDiscovered(roots: DiscoveryRoots, source: AgentDefSource, name: string): LoadedAgent | null {
  for (const loc of locations(roots)) {
    if (loc.source !== source) continue;
    for (const path of agentFiles(loc.dir, loc.ext)) {
      const agent = loc.load(path, loc.location);
      if (agent?.fields.name === name) return agent;
    }
  }
  return null;
}

/** Load an agent file named by path: by its folder (`.claude/`, `.codex/`, `.pi/`) or extension; else Glade's format. */
export function loadAgentFile(path: string): LoadedAgent | null {
  const normalized = path.replace(/\\/g, "/");
  if (extname(path) === ".toml") return loadCodexAgent(path, "personal");
  if (/\/\.claude\/agents\//.test(normalized)) return loadClaudeAgent(path, "personal");
  if (/\/\.pi\/(agent\/)?agents\//.test(normalized)) return loadPiAgent(path, "personal");
  return loadGladeAgent(path, "personal", "personal");
}

