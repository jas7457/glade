/**
 * Glade agents (I-218): finds, reads, resolves and writes agent definitions (see
 * `@glade/protocol` `agent-defs.ts` for the format and rules). One instance per server
 * (`AppContext.agentDefs`); the agent team (`services/app/agent-team.ts`) resolves a spawn's
 * `agent` through {@link AgentDefsService.resolve}, Settings uses the REST routes
 * (`http/agent-defs.ts`), and harness sessions report the tools they saw
 * ({@link AgentDefsService.recordTools}).
 *
 * CONTRACT (lead, I-218): the method signatures below are shared by the agent-defs worker (who
 * implements this file and the folder around it) and the spawn worker (who calls it). Keep them
 * stable; add, don't change.
 */
import type { AgentDef, AgentDefScope, AgentDefToolsResponse, SaveAgentDefRequest } from "@glade/protocol";

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
 */
export interface ResolvedAgentDef {
  def: AgentDef;
  native: { claude?: Record<string, unknown>; codex?: Record<string, unknown> };
}

export interface AgentDefsServiceOptions {
  /** Glade's data folder (personal agents in `<dataDir>/agents`). */
  dataDir: string;
  /** Home folder (discovery of `~/.claude/agents`, `~/.codex/agents`, `~/.pi/agent`); injectable for tests. */
  homeDir?: string;
  log?: (msg: string) => void;
}

export class AgentDefsService {
  constructor(readonly options: AgentDefsServiceOptions) {}

  /** Every definition visible in `scope` (Glade's, then discovered), with switches and availability. */
  async list(_scope: AgentDefsScope, _ctx: AgentDefsListContext): Promise<AgentDef[]> {
    return [];
  }

  /**
   * The enabled, available definition named `name` that wins in `scope` (project over personal over
   * discovered). Throws `HttpError(400)` naming the available ones when unknown/unavailable.
   */
  async resolve(name: string, _scope: AgentDefsScope, _ctx: AgentDefsListContext): Promise<ResolvedAgentDef> {
    throw new Error(`Unknown agent "${name}"`);
  }

  /** Create/replace (rename with `previousName`) a Glade agent file; validates (HttpError 400). */
  async save(_req: SaveAgentDefRequest, _projectDir: string | null, _ctx: AgentDefsListContext): Promise<AgentDef> {
    throw new Error("not implemented");
  }

  /** Delete a Glade agent file. */
  async remove(_scope: AgentDefScope, _name: string, _projectDir: string | null): Promise<void> {
    throw new Error("not implemented");
  }

  /** A harness session saw these tools (pi: `getAllTools()`; Claude Code: init `tools`/`mcp_servers`). */
  recordTools(_harness: string, _projectId: string | null, _tools: string[], _mcpServers: string[]): void {}

  /** The tools last seen for `harness` in `projectId` (falls back to any project's). */
  tools(harness: string, _projectId: string | null): AgentDefToolsResponse {
    return { harness, tools: [], mcpServers: [], seenAt: null };
  }
}

/** What `list`/`resolve` need from the server to fill `enabled`/`available`/`problems`. */
export interface AgentDefsListContext {
  /** Settings' on/off switches. */
  switches: import("@glade/protocol").AgentDefSwitches;
  /** Harness ids this device offers right now (installed and on). */
  offeredHarnesses: string[];
}
