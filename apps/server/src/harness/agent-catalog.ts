/**
 * The agents this device can run (I-155): pi (or the dev fake), the well-known ACP agents
 * (`KNOWN_ACP_AGENTS`: Claude Code, Gemini CLI, Codex) and the ACP agents the user added.
 *
 * - {@link acpAgentConfigs}: the ACP agents that become harnesses: the user's, plus each known
 *   agent whose command is installed (found on the PATH; nothing is started). A user's agent with
 *   the same id or command replaces the known one.
 * - {@link buildAgentCatalog}: `GET /api/agent-catalog` for Settings → Agents: every agent with
 *   installed / enabled / offered, and install links for missing known ones.
 */
import {
  KNOWN_ACP_AGENTS,
  PI_INSTALL,
  acpHarnessId,
  isAgentEnabled,
  knownAcpAgentFor,
  normalizeAcpAgents,
  type AcpAgentConfig,
  type AgentCatalogEntry,
  type KnownAcpAgent,
  type Settings,
} from "@glade/protocol";
import type { HarnessRegistry } from "./registry.js";
import type { AgentHarness } from "./types.js";
import type { WhichFn } from "./which.js";

const base = (command: string) => command.split("/").pop() ?? command;

/** A known agent is replaced by a user's agent with its id or one of its commands. */
function shadowed(known: KnownAcpAgent, custom: readonly AcpAgentConfig[]): boolean {
  return custom.some((c) => c.id === known.id || known.commands.includes(base(c.command)));
}

/** The ACP agents that are harnesses: the user's, then the installed known ones. */
export function acpAgentConfigs(customRaw: unknown, which: WhichFn): AcpAgentConfig[] {
  const custom = normalizeAcpAgents(customRaw);
  const known: AcpAgentConfig[] = [];
  for (const agent of KNOWN_ACP_AGENTS) {
    if (shadowed(agent, custom)) continue;
    const command = agent.commands.find((c) => which(c));
    if (command) known.push({ id: agent.id, name: agent.name, command, args: [...agent.args], env: {} });
  }
  return [...custom, ...known];
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map((a) => (/[\s"']/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ");
}

export interface AgentCatalogOptions {
  harnesses: HarnessRegistry;
  settings: Settings;
}

/** Settings → Agents: every agent this device knows about (see the header). */
export function buildAgentCatalog({ harnesses, settings }: AgentCatalogOptions): AgentCatalogEntry[] {
  const custom = normalizeAcpAgents(settings.harnesses.acp?.agents);
  const customIds = new Set(custom.map((c) => acpHarnessId(c.id)));
  const defaultId = harnesses.info().find((h) => h.isDefault)?.id ?? null;
  const entry = (h: AgentHarness): AgentCatalogEntry => {
    const installed = harnesses.isInstalled(h);
    const enabled = isAgentEnabled(settings, h.id);
    const config = (h as { config?: AcpAgentConfig }).config;
    const known = customIds.has(h.id) ? undefined : knownAcpAgentFor(h.id);
    const kind: AgentCatalogEntry["kind"] = customIds.has(h.id) ? "custom" : known ? "known" : "builtin";
    const command = config ? commandLine(config.command, config.args) : h.id === "pi" ? settings.harnesses.pi.piPath || "pi" : null;
    const install = h.id === "pi" ? PI_INSTALL : known ? { installUrl: known.installUrl, installHint: known.installHint } : {};
    return { id: h.id, label: h.info.label, kind, command, installed, enabled, offered: installed && enabled, isDefault: h.id === defaultId, ...install };
  };
  const list = harnesses.list();
  const out = list.map(entry);
  // Known agents that aren't installed (so aren't harnesses): listed with an install link.
  for (const agent of KNOWN_ACP_AGENTS) {
    const id = acpHarnessId(agent.id);
    if (list.some((h) => h.id === id) || shadowed(agent, custom)) continue;
    out.push({
      id,
      label: agent.name,
      kind: "known",
      command: commandLine(agent.commands[0]!, agent.args),
      installed: false,
      enabled: isAgentEnabled(settings, id),
      offered: false,
      isDefault: false,
      installUrl: agent.installUrl,
      installHint: agent.installHint,
    });
  }
  return out;
}
