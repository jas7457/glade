/**
 * The Agents page (I-155, I-159): the agents a device can run (pi and Claude Code for now),
 * whether each is found there, and whether the device offers it. A device offers only agents that
 * are installed *and* enabled (`Settings.agents.<harnessId>.enabled`, on unless turned off);
 * `GET /api/harnesses` lists just those, so new chats, pickers, sub-agents and other devices only
 * see what the host offers. `GET /api/agent-catalog` → `AgentCatalogEntry[]` lists them all.
 *
 * ACP agents the user added (I-119) stay stored but are hidden and never offered (I-159; F-026).
 */
import { acpHarnessId, isAcpHarnessId } from "./acp.js";

/** A well-known ACP agent Glade offers without setup when its command is on the PATH. */
export interface KnownAcpAgent {
  /** ACP agent id; the harness id is `acp-<id>`. */
  id: string;
  name: string;
  /** Commands to look for on the PATH, in order (the first one found is used). */
  commands: string[];
  args: string[];
}

export const KNOWN_ACP_AGENTS: readonly KnownAcpAgent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    commands: ["claude-agent-acp", "claude-code-acp"],
    args: [],
  },
];

/** The command pi is started with: always `pi` found on the PATH (I-159). */
export const PI_COMMAND = "pi";

export function knownAcpAgentFor(harnessId: string): KnownAcpAgent | undefined {
  return KNOWN_ACP_AGENTS.find((a) => acpHarnessId(a.id) === harnessId);
}

/** An ACP agent the user added (not a known one): hidden and never offered since I-159. */
export function isCustomAcpHarness(harnessId: string): boolean {
  return isAcpHarnessId(harnessId) && !knownAcpAgentFor(harnessId);
}

/** `Settings.agents`: per-agent switches, keyed by harness id. */
export type AgentSwitches = Record<string, { enabled?: boolean }>;

/**
 * Whether the device offers agent `harnessId` when it's installed (on unless turned off). The
 * user's own ACP agents never are (I-159: hidden for now, kept in the settings).
 */
export function isAgentEnabled(settings: { agents?: AgentSwitches }, harnessId: string): boolean {
  if (isCustomAcpHarness(harnessId)) return false;
  return settings.agents?.[harnessId]?.enabled !== false;
}

export interface AgentCatalogEntry {
  /** Harness id ("pi", "acp-claude-code"). */
  id: string;
  label: string;
  /** builtin: pi (or the dev fake); known: a well-known ACP agent. */
  kind: "builtin" | "known";
  /** The command line it runs (display), `null` when not applicable. */
  command: string | null;
  /** The commands looked for on the PATH (for "Not found: looked for …"); empty when not applicable. */
  lookedFor: string[];
  /** Found on this device (the command is on the PATH). */
  installed: boolean;
  /**
   * The stored Enable preference (`Settings.agents.<id>.enabled`, on by default). The switch
   * shows `installed && enabled` and is disabled while the agent isn't installed.
   */
  enabled: boolean;
  /** Installed and enabled: listed by `GET /api/harnesses`. */
  offered: boolean;
  /** New chats use it. */
  isDefault: boolean;
}
