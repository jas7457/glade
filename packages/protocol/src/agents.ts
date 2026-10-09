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
  /**
   * The harness's own sub-agent (I-188: Claude Code's Task/Agent tool, Codex's `spawn_agent`),
   * named by the harness's label ("Claude Code"). Glade mirrors its transcript read-only: it
   * can't be messaged, and it isn't part of the agent API (list/message/close_agent).
   */
  native?: string;
}

export interface AgentInfo {
  /** Code name from spawn_agent: the id for message_agent/close_agent. */
  name: string;
  /** Fun display name the user sees (I-084), e.g. "Leo"; absent for agents from before. */
  displayName?: string;
  /** Its colour key (`AgentColor`, I-084), when it has one. */
  color?: string;
  /** Its icon (`AgentIcon`, I-218), from its agent definition. */
  icon?: string;
  /** The harness it runs on (I-217); may differ from its parent's. */
  harness?: string;
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
  /**
   * Name of the agent definition (I-218): the server resolves it (Glade agents, discovered Claude
   * Code / Codex / pi agents, `extends`) and applies its harness, model, thinking, prompt, tools and
   * identity. Unknown or unavailable → 400 listing the available ones.
   */
  agent?: string;
  /**
   * Legacy (pi extension before I-218, ext-kit agent-teams): the definition's instructions,
   * appended to the sub-agent's role prompt. Ignored when the server resolved `agent`.
   */
  agentPrompt?: string;
  /** Harness id to run on (I-217); default: the definition's, else the parent's (`inherit`). */
  harness?: string;
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

/**
 * Sub-agent colours (I-084): keys of CSS tokens `--pi-agent-<key>` in the web app. Assigned at
 * spawn, unique among a workspace's active agents while possible.
 */
export const AGENT_COLORS = ["coral", "amber", "lime", "teal", "sky", "indigo", "violet", "pink"] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

/**
 * A sub-agent a main session spawned (I-084; `SessionSummary.spawnedAgents`), kept after it
 * closed (its session is deleted then) so the parent's spawn cards keep its name and colour.
 */
export interface SpawnedAgentRef {
  /** Functional name from spawn_agent (the `task` tool call's `input.agentName`). */
  name: string;
  /** Its session id (the session may no longer exist). */
  sessionId: string;
  displayName?: string;
  color?: string;
  /** Its icon (`AgentIcon`, I-218), from its agent definition. */
  icon?: string;
  /** The agent definition it was started from (I-218), e.g. `scout`. */
  agent?: string;
  /** The harness it ran on (I-217); may differ from the parent's. */
  harness?: string;
  spawnedAt: number;
  /**
   * The parent's tool call that started it (I-188, native sub-agents): links that call's card to
   * the agent directly (Glade's own spawns are matched by name).
   */
  toolCallId?: string;
  /** The harness's own sub-agent (I-188; see `SessionAgentState.native`). */
  native?: boolean;
}
