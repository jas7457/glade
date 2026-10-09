/**
 * Glade's own sub-agent and chat tools for Claude Code (I-037, I-116, I-173), served by an
 * in-process MCP server (`mcp__glade__spawn_agent`, …). The tools are exactly the ones pi gets
 * from Glade's pi extension (`../pi/extension/glade-tools.ts`: same specs, same agent-API client,
 * same result texts), registered through a small adapter instead of pi's extension API. They run
 * inside the Glade server with the session's agent-API identity, so the identity never reaches
 * the Claude Code process.
 */
import { readIdentity, registerGladeTools, type PiExtensionApi, type SpawnableAgentList } from "../pi/extension/glade-tools.js";
import type { ClaudeMcpToolSpec } from "./sdk.js";

/**
 * pi tool names Claude Code has an equivalent of (for agent definitions' `tools` lists, checked
 * by `spawn_agent`) → Claude Code's tool names.
 */
export const PI_TO_CLAUDE_TOOLS: Readonly<Record<string, string[]>> = {
  read: ["Read"],
  bash: ["Bash"],
  edit: ["Edit", "MultiEdit"],
  write: ["Write"],
  grep: ["Grep"],
  find: ["Glob"],
  ls: ["Glob"],
};

/**
 * Claude Code's names for a sub-agent's tool allowlist: pi names are mapped, Claude Code's own
 * (`Read`) and MCP tools (`mcp__server__tool`, I-218) kept, anything else dropped. Glade's own tools
 * always stay (they're not restricted by this list).
 */
export function claudeToolAllowlist(tools: readonly string[]): string[] {
  const out = new Set<string>();
  for (const tool of tools) for (const name of PI_TO_CLAUDE_TOOLS[tool] ?? (/^[A-Z]/.test(tool) || tool.startsWith("mcp__") ? [tool] : [])) out.add(name);
  return [...out];
}

/** The MCP server Glade's own tools are served by (`mcp__glade__spawn_agent`, …). */
export const GLADE_MCP_SERVER = "glade";

export interface GladeToolsOptions {
  /** The session's agent-API identity (`GLADE_URL`, `GLADE_TOKEN`, …; `AGENT_ENV`). */
  env: Record<string, string>;
  /** The "Use sub-agents" setting. */
  subagents: boolean;
  /** The chat's folder. */
  cwd: string;
  /** What spawn_agent lists (I-218; main sessions). */
  agents?: SpawnableAgentList | null;
  /** The calling harness's id (spawn results name another harness, I-217). */
  harness?: string;
  fetch?: typeof fetch;
}

/** The tools for this session; none without an agent-API identity. */
export function gladeToolSpecs({ env, subagents, cwd, agents, harness, fetch: fetchImpl }: GladeToolsOptions): ClaudeMcpToolSpec[] {
  const identity = readIdentity(env);
  if (!identity) return [];
  const tools: ClaudeMcpToolSpec[] = [];
  const api: PiExtensionApi = {
    registerTool(tool) {
      const guidelines = tool.promptGuidelines?.length ? `\n\n${tool.promptGuidelines.join("\n")}` : "";
      tools.push({
        name: tool.name,
        description: tool.description + guidelines,
        parameters: tool.parameters,
        async handler(args) {
          const result = await tool.execute("", args, undefined, undefined, { cwd });
          return { content: result.content };
        },
      });
    },
    getAllTools: () => [...Object.keys(PI_TO_CLAUDE_TOOLS), ...tools.map((t) => t.name)].map((name) => ({ name })),
    on() {},
  };
  registerGladeTools(api, { ...identity, subagents, ...(harness ? { harness } : {}) }, fetchImpl, agents);
  return tools;
}
