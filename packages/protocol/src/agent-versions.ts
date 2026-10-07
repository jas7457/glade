/**
 * Agent versions and updates (I-198): which version of each built-in agent (pi, Claude Code,
 * Codex) is installed on a device, the newest one available, and an Update that runs the agent's
 * own updater there. Each device checks and updates its own agents; another device's go through
 * the device switcher (paired devices may read and start updates, like Local Models).
 *
 *   GET  /api/agent-versions                         → AgentVersionsStatus
 *   POST /api/agent-versions/check                   → AgentVersionsStatus (checks now, answers when done)
 *   POST /api/agent-versions/:harness/update         → AgentVersionsStatus (starts or queues it;
 *                                                     404 unknown agent, 409 with `error` when one runs
 *                                                     or the agent can't be updated)
 *   POST /api/agent-versions/:harness/update/cancel  → AgentVersionsStatus (only while waiting)
 *
 * Also pushed as `agent_versions` after every change. Checks run at startup, about daily, and when
 * the Agents page opens (`check`); they're read-only (version commands + one HTTPS GET each).
 *
 * An update starts right away when no chat of that agent is working on this device; otherwise it
 * waits (`waiting`) until they all finish, like Glade's own restart (I-197). Afterwards the agent's
 * model list is reloaded, so new models show up without restarting Glade. Chats that are open but
 * idle use the new version when their agent process next starts.
 */

/** Built-in agents Glade can check and update, with their updater command. */
export const AGENT_UPDATE_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  pi: "pi update self",
  claude: "claude update",
  codex: "codex update",
});

/**
 * - `up-to-date`: installed is the newest.
 * - `behind`: a newer version is available (`latest`).
 * - `not-installed`: the agent's command isn't on the PATH.
 * - `failed`: the check failed (offline, unexpected output…): `reason`.
 * - `unknown`: not checked yet, or this agent has no version source.
 */
export type AgentVersionState = "up-to-date" | "behind" | "not-installed" | "failed" | "unknown";

/**
 * - `waiting`: queued until this agent's working chats finish (`waitingFor` of them).
 * - `running`: the updater runs (`log` streams).
 * - `done`: it finished (exit 0); versions were re-read and models reloaded.
 * - `failed`: non-zero exit or couldn't start (`error`; the log says more).
 * - `cancelled`: cancelled while waiting.
 */
export type AgentUpdateState = "waiting" | "running" | "done" | "failed" | "cancelled";

export interface AgentUpdateJob {
  state: AgentUpdateState;
  /** The command it runs, e.g. `claude update`. */
  command: string;
  /** Chats of this agent still working (`waiting` only). */
  waitingFor?: number;
  /** Version before / after the update (when known). */
  from?: string | null;
  to?: string | null;
  /** Why it failed, in a sentence. */
  error?: string;
  /** The last lines of the updater's output (a ring buffer). */
  log: string[];
  /** ISO times. */
  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
}

export interface AgentVersionInfo {
  /** Harness id (`pi`, `claude`, `codex`). */
  harness: string;
  /** Installed version (e.g. "2.1.280"), null when not installed or unreadable. */
  installed: string | null;
  /** Newest available version, null when unknown. */
  latest: string | null;
  state: AgentVersionState;
  /** Where `latest` comes from, for display (e.g. "npm", "Claude Code latest channel"). */
  source?: string;
  /** Why (`failed` / `unknown`), in a sentence. */
  reason?: string;
  /** ISO time of the last finished check. */
  checkedAt: string | null;
  /** The command Update runs; null when Glade can't update this agent. */
  updateCommand: string | null;
  /** The current or last update job since the server started. */
  update: AgentUpdateJob | null;
}

export interface AgentVersionsStatus {
  /** One per built-in agent this device knows (installed or not). */
  agents: AgentVersionInfo[];
  /** A check is running. */
  checking: boolean;
}
