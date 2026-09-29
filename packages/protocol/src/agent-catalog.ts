/**
 * The Agents page (I-155): every agent a device can run, whether it's installed there, and
 * whether the device offers it. A device offers only agents that are installed *and* enabled
 * (`Settings.agents.<harnessId>.enabled`, on unless turned off); `GET /api/harnesses` lists just
 * those, so new chats, pickers, sub-agents and other devices only see what the host offers.
 * `GET /api/agent-catalog` → `AgentCatalogEntry[]` lists them all (for Settings → Agents).
 */
import { acpHarnessId } from "./acp.js";

/** A well-known ACP agent Glade offers without setup when its command is on the PATH. */
export interface KnownAcpAgent {
  /** ACP agent id; the harness id is `acp-<id>`. */
  id: string;
  name: string;
  /** Commands to look for, in order (the first one found is used). */
  commands: string[];
  args: string[];
  /** Official install instructions. */
  installUrl: string;
  /** One-line hint shown when it's missing. */
  installHint: string;
}

export const KNOWN_ACP_AGENTS: readonly KnownAcpAgent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    commands: ["claude-agent-acp", "claude-code-acp"],
    args: [],
    installUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
    installHint: "npm install -g @agentclientprotocol/claude-agent-acp",
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    commands: ["gemini"],
    args: ["--experimental-acp"],
    installUrl: "https://github.com/google-gemini/gemini-cli#-installation",
    installHint: "npm install -g @google/gemini-cli",
  },
  {
    id: "codex",
    name: "Codex",
    commands: ["codex-acp"],
    args: [],
    installUrl: "https://github.com/zed-industries/codex-acp",
    installHint: "npm install -g @zed-industries/codex-acp",
  },
];

/** pi's install instructions. */
export const PI_INSTALL = {
  installUrl: "https://github.com/earendil-works/pi",
  installHint: "npm install -g @earendil-works/pi-coding-agent",
} as const;

export function knownAcpAgentFor(harnessId: string): KnownAcpAgent | undefined {
  return KNOWN_ACP_AGENTS.find((a) => acpHarnessId(a.id) === harnessId);
}

/** `Settings.agents`: per-agent switches, keyed by harness id. */
export type AgentSwitches = Record<string, { enabled?: boolean }>;

/** Whether the device offers agent `harnessId` when it's installed (on unless turned off). */
export function isAgentEnabled(settings: { agents?: AgentSwitches }, harnessId: string): boolean {
  return settings.agents?.[harnessId]?.enabled !== false;
}

export interface AgentCatalogEntry {
  /** Harness id ("pi", "acp-claude-code", "acp-<custom id>"). */
  id: string;
  label: string;
  /** builtin: pi (or the dev fake); known: a well-known ACP agent; custom: one the user added. */
  kind: "builtin" | "known" | "custom";
  /** The command line it runs (display), `null` when not applicable. */
  command: string | null;
  /** Found on this device (the command is on the PATH / the path exists). */
  installed: boolean;
  /** The Enable switch (`Settings.agents.<id>.enabled`, on by default). */
  enabled: boolean;
  /** Installed and enabled: listed by `GET /api/harnesses`. */
  offered: boolean;
  /** New chats use it. */
  isDefault: boolean;
  installUrl?: string;
  installHint?: string;
}
