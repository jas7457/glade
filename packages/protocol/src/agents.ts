/**
 * Agent API (I-037): lets an agent running inside Glade spawn and talk to sub-agents, which run
 * as `subagent` sessions of the caller's workspace. Used by the ext-kit agent-teams extension's
 * Glade backend (it duplicates these shapes; keep them in sync).
 *
 * Every agent process Glade starts gets {@link AGENT_ENV} variables (and, for agent-teams
 * versions from before the rename, the same values under {@link LEGACY_AGENT_ENV}). Requests to
 * `/api/agents/…` carry `Authorization: Bearer <GLADE_TOKEN>`; the token identifies the calling
 * session.
 */

/** Environment variables Glade sets for every agent process it starts. */
export const AGENT_ENV = {
  /** Base URL of the Glade server, e.g. `http://127.0.0.1:4317`. */
  url: "GLADE_URL",
  /** The session this process runs. */
  sessionId: "GLADE_SESSION_ID",
  /** Secret for the agent API; per process, only valid while the process runs. */
  token: "GLADE_TOKEN",
  /** Set only for sub-agents: their agent name (the process is a child and can't spawn). */
  agentName: "GLADE_AGENT_NAME",
} as const;

/**
 * The pre-rename names of {@link AGENT_ENV} (I-059, app formerly "pi-ui"), set alongside it with
 * the same values so an agent-teams extension that only knows these keeps working.
 */
export const LEGACY_AGENT_ENV = {
  url: "PI_UI_URL",
  sessionId: "PI_UI_SESSION_ID",
  token: "PI_UI_TOKEN",
  agentName: "PI_UI_AGENT_NAME",
} as const satisfies Record<keyof typeof AGENT_ENV, string>;

/** Max sub-agents running at once per workspace (closed ones don't count). */
export const MAX_ACTIVE_AGENTS = 4;

/**
 * - `working` / `idle`: running (idle = waiting between turns)
 * - `done`: called report_done and is still open (kept open or the user typed in it)
 * - `closed`: finished for good. Closing a sub-agent (report_done with auto-close, close_agent,
 *   the idle timeout, or the user closing its tab) **deletes its tab and conversation** (I-055);
 *   its result stays in the parent chat. An agent whose process crashed is `closed` too, but its
 *   tab stays (`tabOpen`) so the error is readable; typing in it starts it again.
 */
export type AgentStatus = "working" | "idle" | "done" | "closed";

/**
 * A sub-agent's state as the browser sees it (I-054): `SessionSummary.agent` of `subagent`
 * sessions, pushed with every `session_upsert`.
 */
export interface SessionAgentState {
  status: AgentStatus;
  /** Agent definition used, if any. */
  agent: string | null;
  task: string;
  keepOpenReason: string | null;
  userEngaged: boolean;
  /** Closes when its current turn ends (report_done with auto-close, or close_agent). */
  closing: boolean;
  doneAt: number | null;
  /** The report_done summary. */
  result: string | null;
}

export interface AgentInfo {
  name: string;
  /** Its session (tab) id. */
  sessionId: string;
  /** Agent definition used, if any. */
  agent: string | null;
  task: string;
  status: AgentStatus;
  keepOpenReason: string | null;
  /** The user typed in its tab: it's never closed automatically. */
  userEngaged: boolean;
  spawnedAt: number;
  doneAt: number | null;
  /** The report_done summary. */
  result: string | null;
  /** Its tab (session) still exists; `false` once closed (the conversation was deleted). */
  tabOpen: boolean;
}

/** `POST /api/agents/spawn` (main sessions only). */
export interface SpawnAgentRequest {
  /** Lowercase letters, digits, dashes; normalized by the server. Unique among the caller's active agents. */
  name: string;
  /** Complete task; sent as the sub-agent's first prompt. */
  task: string;
  /** Name of the agent definition (for display/list). */
  agent?: string;
  /** The definition's instructions, appended to the sub-agent's role prompt. */
  agentPrompt?: string;
  /** `provider/id` or a bare model id. Default: the caller's model. */
  model?: string;
  /** Default: the caller's thinking level. */
  thinking?: string;
  /** Tool allowlist (report_done and message_agent are always added). */
  tools?: string[];
  /** Keep it running after report_done. Requires `keepOpenReason`. */
  keepOpen?: boolean;
  keepOpenReason?: string;
}

export interface SpawnAgentResponse {
  agent: AgentInfo;
}

/** `POST /api/agents/message`. `to` is a sub-agent name, or `"main"` (a sub-agent's parent). */
export interface MessageAgentRequest {
  to: string;
  text: string;
}

/** `POST /api/agents/close` (the parent closes one of its sub-agents). */
export interface CloseAgentRequest {
  name: string;
}

export interface CloseAgentResponse {
  /** `true`: closed now (tab removed); `false`: closes when its current turn ends. */
  closed: boolean;
  /** It was already closed (not an error: close_agent is idempotent). */
  alreadyClosed?: boolean;
}

/** `POST /api/agents/report-done` (sub-agents only). */
export interface ReportDoneRequest {
  summary: string;
  /** Stay open even if auto-close is on. */
  keepOpen?: boolean;
}

export interface ReportDoneResponse {
  /** The sub-agent is stopped when its current turn ends. */
  closing: boolean;
}

/** `GET /api/agents`: the caller's team (a main session's sub-agents, or a sub-agent's siblings). */
export interface ListAgentsResponse {
  self: { sessionId: string; role: "main" | "subagent"; name: string | null };
  agents: AgentInfo[];
}
