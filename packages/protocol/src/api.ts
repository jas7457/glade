/**
 * REST + WebSocket contract between the web client and the pi-ui server.
 */
import type { AgentEvent, SessionState, UiResponse } from "./events.js";
import type { ModelInfo, ModelRef, ThinkingLevel } from "./models.js";
import type { Transcript } from "./transcript.js";
import type { ChatStatus } from "./status.js";
import type { SessionAgentState } from "./agents.js";

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  /** Absolute folder path on disk. Chats in this project run with this as cwd. */
  path: string;
  /** Manual position in the sidebar (ascending). New projects get the lowest value (top). */
  sortOrder: number;
  createdAt: number;
  /** Updated whenever one of its chats has activity. Not used for ordering. */
  lastActivityAt: number;
}

/**
 * One sidebar row (I-035): a titled container of agent sessions running in one folder (a
 * project's, or the scratch folder for standalone workspaces). Workspaces are independent of each
 * other, even in the same project. Ordering, pinning and project membership live here; everything
 * about a conversation lives on its {@link Session}s.
 */
export interface Workspace {
  id: string;
  /** `null` for standalone workspaces (they run in the scratch folder). */
  projectId: string | null;
  title: string;
  /** `auto` titles follow the first main session's title; `user` titles never change on their own. */
  titleSource: "auto" | "user";
  /** Working directory every session of this workspace runs in. */
  cwd: string;
  pinned: boolean;
  /** Position among the pinned workspaces of the same list (ascending). Only meaningful when pinned. */
  pinOrder?: number;
  createdAt: number;
  /** Latest activity in any of its sessions. Not used for ordering. */
  lastActivityAt: number;
  /** Saved tab/pane layout (I-036). `null` until the UI stores one; the server treats it as opaque. */
  layout: WorkspaceLayout | null;
}

/**
 * Saved layout of a workspace's tabs. Placeholder for I-036: the server stores and returns it
 * without interpreting it (unknown session ids are the client's to ignore).
 */
export interface WorkspaceLayout {
  /** Main tabs in display order (session ids). Sessions missing here go after, by `createdAt`. */
  mainOrder?: string[];
  /** Focused main tab. */
  activeMainSessionId?: string | null;
  /** Focused sub-agent tab per main session id. */
  activeSubagentSessionId?: Record<string, string>;
  /** Width of the sub-agent pane as a fraction of the content area (0..1). */
  subagentPaneSize?: number;
}

/** `main`: a tab in the main area. `subagent`: spawned by another session of the workspace (I-037). */
export type SessionKind = "main" | "subagent";

/**
 * One agent conversation (one harness session file) inside a workspace. Sessions never get their
 * own sidebar rows. All per-conversation state (transcript, live process, model, unread,
 * interrupted runs, …) is keyed by the session id.
 */
export interface Session {
  id: string;
  workspaceId: string;
  kind: SessionKind;
  /** The session that spawned this one (`subagent` only; `null` for main sessions). */
  parentSessionId: string | null;
  /** Agent name shown on a sub-agent's tab (`subagent` only). */
  agentName: string | null;
  /** Tab title. */
  title: string;
  /** `auto` titles may be replaced by generated ones; `user` titles never are. */
  titleSource: "auto" | "user";
  /** Which harness owns this session (e.g. "pi"). */
  harness: string;
  /** Harness specific reference to the persisted session (for pi: the session .jsonl path). */
  sessionRef: string | null;
  /** A run finished while the session wasn't being viewed. */
  unread: boolean;
  /** The most recent run ended with an error or the agent crashed. Cleared when a new run starts. */
  lastRunFailed?: boolean;
  /** Server-internal: a run started and hasn't finished yet (survives restarts; see I-025). */
  runInProgress?: boolean;
  /** The last run was cut off (app quit, crash, agent died). Cleared by any new prompt or dismissal. */
  interrupted?: boolean;
  createdAt: number;
  lastActivityAt: number;
  /** Last model / thinking level used, so re-opening restores them. */
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
}

/** Session plus runtime state that isn't persisted. */
export interface SessionSummary extends Session {
  running: boolean;
  /** Open agent dialogs waiting for the user. */
  pendingInputs: number;
  /** Derived with `deriveChatStatus` - the single field the UI should use for indicators. */
  status: ChatStatus;
  /** Sub-agent state (`subagent` sessions spawned via the agent API; absent otherwise). */
  agent?: SessionAgentState;
  /**
   * I-062: another pi-ui server sharing this data folder is running this session's agent right
   * now (working or waiting for input). This server shows it read-only: prompts answer 409 until
   * it's idle there (then this server takes it over on the next prompt).
   */
  activeElsewhere?: ActiveElsewhere;
}

/** Where a session is active when it isn't this server (see `SessionSummary.activeElsewhere`). */
export interface ActiveElsewhere {
  /** The other server's kind: `"dev"` (pnpm dev) or `"desktop"` (the installed app), or another label. */
  serverKind: string;
  /** When that server took the session (ms since epoch). */
  since: number;
}

/** Human label for a server kind ("pi-ui (dev)", "pi-ui"). */
export function serverKindLabel(kind: string): string {
  return kind === "desktop" ? "pi-ui" : `pi-ui (${kind})`;
}

/** The 409 message for a session that is active in another server. */
export function activeElsewhereMessage(elsewhere: Pick<ActiveElsewhere, "serverKind">): string {
  return `Running in ${serverKindLabel(elsewhere.serverKind)} — open it there or wait until it's idle`;
}

/** Workspace plus state rolled up from all of its sessions (see `rollupWorkspace`). */
export interface WorkspaceSummary extends Workspace {
  /** Most urgent session status (blocked > working > unread > idle). */
  status: ChatStatus;
  /** Any session is running. */
  running: boolean;
  /** Open dialogs across all sessions. */
  pendingInputs: number;
  /** Any session has an unread finished run. */
  unread: boolean;
  /** Any session's last run failed. */
  lastRunFailed: boolean;
  /** Any session's last run was interrupted. */
  interrupted: boolean;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export interface Settings {
  general: {
    /** Which key sends a message. The other inserts a newline. */
    sendKey: "enter" | "mod-enter";
    /** What happens when sending while the agent is running. */
    busyBehavior: "steer" | "followUp";
    /** Generate a title for new chats with a model (a quick title is always set first). */
    generateTitles: boolean;
    /**
     * Generate a one-line summary of each chat with the fast (title) model after its runs (I-046).
     * Summaries help the chat finder (⌘K "Ask") match paraphrased requests.
     */
    generateSummaries: boolean;
  };
  models: {
    /** Model for new chats. `null` = harness default. */
    defaultModel: ModelRef | null;
    defaultThinkingLevel: ThinkingLevel;
    /** Model used for title generation. `null` = use the chat's model. */
    titleModel: ModelRef | null;
    /** Model keys (`provider/id`) hidden from the picker. */
    hiddenModels: string[];
  };
  appearance: {
    theme: "system" | "light" | "dark";
    fontSize: "small" | "medium" | "large";
  };
  agent: {
    /** Path to the pi executable (or just "pi" to use PATH). */
    piPath: string;
    /** Extra CLI arguments passed to every pi process. */
    extraArgs: string[];
    /** Maximum number of idle agent processes kept alive. Running ones are never killed. */
    maxIdleProcesses: number;
    autoCompaction: boolean;
    autoRetry: boolean;
  };
  /** Slash menu (I-048). */
  slashCommands: {
    /**
     * Commands hidden from the slash menu, as `<source>:<name>` keys (e.g. `builtin:compact`,
     * `extension:powerline`, `skill:skill:web-design`). Hidden commands still run when typed in
     * full. Unknown keys are ignored.
     */
    hidden: string[];
  };
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export function defaultSettings(): Settings {
  return {
    general: {
      sendKey: "enter",
      busyBehavior: "steer",
      generateTitles: true,
      generateSummaries: true,
    },
    models: {
      defaultModel: null,
      defaultThinkingLevel: "medium",
      titleModel: null,
      hiddenModels: [],
    },
    appearance: {
      theme: "system",
      fontSize: "medium",
    },
    agent: {
      piPath: "pi",
      extraArgs: [],
      maxIdleProcesses: 4,
      autoCompaction: true,
      autoRetry: true,
    },
    slashCommands: {
      hidden: [],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------------------------

export interface CreateProjectRequest {
  path: string;
  name?: string;
}

export interface UpdateProjectRequest {
  name?: string;
}

/** `PUT /api/projects/order`: the full list of project ids in their new order. */
export interface ReorderProjectsRequest {
  ids: string[];
}

/** `PUT /api/workspaces/pin-order`: the pinned workspaces of one list (a project, or standalone = null) in order. */
export interface ReorderPinnedWorkspacesRequest {
  projectId: string | null;
  ids: string[];
}

/** Apps a project folder can be opened in (`POST /api/projects/:id/open`). */
export type OpenTarget = "vscode";

export interface OpenProjectRequest {
  app: OpenTarget;
}

/** `POST /api/workspaces`: a new workspace with its first main session. */
export interface CreateWorkspaceRequest {
  projectId: string | null;
  /** Optional first prompt; sent right after the session starts. */
  prompt?: string;
  images?: PromptImage[];
  model?: ModelRef | null;
  thinkingLevel?: ThinkingLevel | null;
}

export interface UpdateWorkspaceRequest {
  title?: string;
  pinned?: boolean;
  /** Replace the saved layout (`null` clears it). */
  layout?: WorkspaceLayout | null;
}

/** `POST /api/workspaces/:id/sessions`: a new main session (tab) in the workspace. */
export interface CreateSessionRequest {
  prompt?: string;
  images?: PromptImage[];
  model?: ModelRef | null;
  thinkingLevel?: ThinkingLevel | null;
}

export interface UpdateSessionRequest {
  title?: string;
  unread?: boolean;
  /** Only `false` is accepted: dismiss the "interrupted" banner. */
  interrupted?: false;
}

export interface PromptImage {
  mimeType: string;
  /** Base64 data (no data: prefix). */
  data: string;
}

export interface PromptRequest {
  text: string;
  images?: PromptImage[];
  /** Required when the agent is running. */
  behavior?: "steer" | "followUp";
}

/** A session with its live state (`GET /api/sessions/:id`; starts the agent if needed). */
export interface SessionDetail {
  session: SessionSummary;
  transcript: Transcript;
  state: SessionState;
  pendingUiRequests: import("./events.js").UiRequest[];
}

/** `GET /api/workspaces/:id`: the workspace and all of its sessions (doesn't start agents). */
export interface WorkspaceDetail {
  workspace: WorkspaceSummary;
  /** Main sessions first (by `createdAt`), then sub-agents (by `createdAt`). */
  sessions: SessionSummary[];
}

/** `POST /api/workspaces`: the new workspace, its sessions, and the first session's live state. */
export interface CreateWorkspaceResponse extends WorkspaceDetail {
  session: SessionDetail;
}

export interface ApiError {
  error: string;
}

export type { UiResponse, ModelInfo };

// ---------------------------------------------------------------------------------------------
// WebSocket (server -> client push)
// ---------------------------------------------------------------------------------------------

export type ServerMessage =
  | { type: "hello"; version: string }
  /** A live agent event of one session. */
  | { type: "session_event"; sessionId: string; workspaceId: string; event: AgentEvent }
  | { type: "session_upsert"; session: SessionSummary }
  | { type: "session_removed"; sessionId: string; workspaceId: string }
  /** Sent after every change to the workspace or any of its sessions (rolled-up status). */
  | { type: "workspace_upsert"; workspace: WorkspaceSummary }
  /** Its sessions are gone too (no separate `session_removed`s are sent). */
  | { type: "workspace_removed"; workspaceId: string }
  | { type: "project_upsert"; project: Project }
  | { type: "project_removed"; projectId: string }
  | { type: "settings"; settings: Settings }
  | { type: "models"; models: ModelInfo[] }
  /** Subscription usage limits; `null` when unavailable (feature hidden). */
  | { type: "usage_limits"; usage: UsageLimits | null };

/**
 * Client -> server messages over the WebSocket. `viewing` lists every session currently on
 * screen (in a visible window), replacing the previous list; finished runs there aren't marked
 * unread.
 */
export type ClientMessage = { type: "viewing"; sessionIds: string[] };

/** Result of `POST /api/fs/pick-folder` (native folder dialog on the server's machine). */
export type PickFolderResponse = { path: string } | { cancelled: true };

// ---------------------------------------------------------------------------------------------
// Slash commands (I-016)
// ---------------------------------------------------------------------------------------------

export type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill";

export interface SlashCommand {
  /** Without the leading slash, e.g. "compact" or "skill:web-design". */
  name: string;
  description?: string;
  source: SlashCommandSource;
  /** Short usage hint for arguments, e.g. "[instructions]". */
  argsHint?: string;
}

export interface CompactResult {
  tokensBefore: number;
  /** Estimate; `null` if unknown. */
  tokensAfter: number | null;
}

// ---------------------------------------------------------------------------------------------
// Subscription usage limits (I-015)
// ---------------------------------------------------------------------------------------------

export interface UsageLimit {
  /** Stable id, e.g. "session", "weekly_all", "weekly_scoped:Fable". */
  id: string;
  /** Display label, e.g. "Current session", "This week", "Fable this week". */
  label: string;
  /** 0-100. */
  percent: number;
  /** ISO timestamp, or null if unknown. */
  resetsAt: string | null;
  severity: "normal" | "warning" | "critical";
  /** This is the limit currently constraining usage. */
  active: boolean;
  /**
   * Set when the limit only applies to one model family (a per-model scope), e.g. "Fable": the
   * model's display name/id fragment. The UI highlights it when the chat's model matches.
   */
  model?: string;
}

export interface UsageLimits {
  /** Which account/provider these limits belong to, e.g. "Claude subscription". */
  source: string;
  /**
   * Model provider these limits apply to (matches `ModelRef.provider`, e.g. "anthropic"). The
   * chat shows them only when its model belongs to this provider.
   */
  provider: string;
  limits: UsageLimit[];
  /** When the numbers were fetched (ms epoch). */
  fetchedAt: number;
  /** True when the last refresh failed/was skipped and these are older values. */
  stale: boolean;
}
