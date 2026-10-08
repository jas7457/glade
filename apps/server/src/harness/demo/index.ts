/**
 * Demo mode (I-209): the website demo's harnesses and their hooks into the server. `src/index.ts`
 * uses these only when `config.harness === "demo"` (a demo sandbox, see `harnessMode`).
 */
import type { AgentVersionsServiceOptions } from "../../services/agent-versions/service.js";
import { DEMO_AGENTS } from "./agents.js";
import { DemoHarness, type DemoHarnessOptions } from "./demo-harness.js";

/** pi, Claude Code and Codex (in that order: pi is the default agent). */
export function createDemoHarnesses(options: DemoHarnessOptions = {}): DemoHarness[] {
  return [DEMO_AGENTS.pi, DEMO_AGENTS.claude, DEMO_AGENTS.codex].map((agent) => new DemoHarness(agent, options));
}

/** Settings → Agents: every agent installed and up to date, without running or fetching anything. */
export function demoAgentVersions(): Pick<AgentVersionsServiceOptions, "readInstalled" | "fetchText" | "claudeChannel"> {
  const version = (id: string) => DEMO_AGENTS[id as keyof typeof DEMO_AGENTS]?.version ?? null;
  return {
    readInstalled: async (id) => {
      const v = version(id);
      return v ? { installed: true, version: v, output: v } : { installed: false };
    },
    // npm answers `{ version }`; Claude Code's release channel answers the bare version.
    fetchText: async (url) => {
      if (url.includes("claude-code-releases")) return DEMO_AGENTS.claude.version;
      const id = url.includes("@openai/codex") ? "codex" : "pi";
      return JSON.stringify({ version: version(id) });
    },
    claudeChannel: () => "latest",
  };
}
