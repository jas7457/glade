/**
 * The agents this device can run (I-155, I-159): pi (or the dev fake) and the well-known ACP
 * agents (`KNOWN_ACP_AGENTS`: Claude Code for now).
 *
 * - {@link acpAgentConfigs}: the ACP agents that become harnesses: each known agent whose command
 *   is installed (found on the PATH; nothing is started), then the ACP agents the user added. Those
 *   are hidden and never offered since I-159 (`isAgentEnabled` is false for them); they stay
 *   harnesses only so their old chats remain readable. A user's agent can't take a known agent's id.
 * - {@link buildAgentCatalog}: `GET /api/agent-catalog` for Settings → Agents: pi and the known
 *   agents with installed / enabled / offered and the commands looked for on the PATH.
 */
import {
  KNOWN_ACP_AGENTS,
  PI_COMMAND,
  acpHarnessId,
  isAgentEnabled,
  isCustomAcpHarness,
  knownAcpAgentFor,
  normalizeAcpAgents,
  type AcpAgentConfig,
  type AgentCatalogEntry,
  type Settings,
} from "@glade/protocol";
import type { HarnessRegistry } from "./registry.js";
import type { AgentHarness } from "./types.js";
import type { WhichFn } from "./which.js";

/** The ACP agents that are harnesses: the installed known ones, then the user's (see the header). */
export function acpAgentConfigs(customRaw: unknown, which: WhichFn): AcpAgentConfig[] {
  const known: AcpAgentConfig[] = [];
  for (const agent of KNOWN_ACP_AGENTS) {
    const command = agent.commands.find((c) => which(c));
    if (command) known.push({ id: agent.id, name: agent.name, command, args: [...agent.args], env: {} });
  }
  const custom = normalizeAcpAgents(customRaw).filter((c) => !KNOWN_ACP_AGENTS.some((k) => k.id === c.id));
  return [...known, ...custom];
}

function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].map((a) => (/[\s"']/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ");
}

export interface AgentCatalogOptions {
  harnesses: HarnessRegistry;
  settings: Settings;
}

/** Settings → Agents: pi (or the fake) and the known agents, installed or not (see the header). */
export function buildAgentCatalog({ harnesses, settings }: AgentCatalogOptions): AgentCatalogEntry[] {
  const defaultId = harnesses.info().find((h) => h.isDefault)?.id ?? null;
  const entry = (h: AgentHarness): AgentCatalogEntry => {
    const installed = harnesses.isInstalled(h);
    const enabled = isAgentEnabled(settings, h.id);
    const config = (h as { config?: AcpAgentConfig }).config;
    const known = knownAcpAgentFor(h.id);
    const pi = h.id === "pi";
    return {
      id: h.id,
      label: h.info.label,
      kind: known ? "known" : "builtin",
      command: config ? commandLine(config.command, config.args) : pi ? PI_COMMAND : null,
      lookedFor: known ? [...known.commands] : pi ? [PI_COMMAND] : [],
      installed,
      enabled,
      offered: installed && enabled,
      isDefault: h.id === defaultId,
    };
  };
  const list = harnesses.list().filter((h) => !isCustomAcpHarness(h.id));
  const out = list.map(entry);
  // Known agents that aren't installed (so aren't harnesses): listed as not found.
  for (const agent of KNOWN_ACP_AGENTS) {
    const id = acpHarnessId(agent.id);
    if (list.some((h) => h.id === id)) continue;
    out.push({
      id,
      label: agent.name,
      kind: "known",
      command: commandLine(agent.commands[0]!, agent.args),
      lookedFor: [...agent.commands],
      installed: false,
      enabled: isAgentEnabled(settings, id),
      offered: false,
      isDefault: false,
    });
  }
  return out;
}
