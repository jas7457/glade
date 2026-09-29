/**
 * Glade's own sub-agent and chat tools for Claude Code (I-037, I-116, I-173), served by an
 * in-process MCP server (`mcp__glade__spawn_agent`, …). The tools are exactly the ones pi gets
 * from Glade's pi extension (`../pi/extension/glade-tools.ts`: same specs, same agent-API client,
 * same result texts), registered through a small adapter instead of pi's extension API. They run
 * inside the Glade server with the session's agent-API identity, so the identity never reaches
 * the Claude Code process.
 */
import { readIdentity, registerGladeTools, type PiExtensionApi } from "../pi/extension/glade-tools.js";
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

/** Claude Code's `tools` for a sub-agent's allowlist of pi tool names (Glade's own tools always stay). */
export function claudeToolAllowlist(tools: readonly string[]): string[] {
  const out = new Set<string>();
  for (const tool of tools) for (const name of PI_TO_CLAUDE_TOOLS[tool] ?? (/^[A-Z]/.test(tool) ? [tool] : [])) out.add(name);
  return [...out];
}

export interface GladeToolsOptions {
  /** The session's agent-API identity (`GLADE_URL`, `GLADE_TOKEN`, …; `AGENT_ENV`). */
  env: Record<string, string>;
  /** The "Use sub-agents" setting. */
  subagents: boolean;
  /** The chat's folder (agent definitions in `<cwd>/.pi/agents`). */
  cwd: string;
  fetch?: typeof fetch;
}

/** The tools for this session; none without an agent-API identity. */
export function gladeToolSpecs({ env, subagents, cwd, fetch: fetchImpl }: GladeToolsOptions): ClaudeMcpToolSpec[] {
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
  registerGladeTools(api, { ...identity, subagents }, fetchImpl);
  return tools;
}
