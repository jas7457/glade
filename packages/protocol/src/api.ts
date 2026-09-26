/**
 * REST + WebSocket contract between the web client and the pi-ui server.
 */
import type { AgentEvent, SessionState, UiResponse } from "./events.js";
import type { ModelInfo, ModelRef, ThinkingLevel } from "./models.js";
import type { Transcript } from "./transcript.js";
import type { ChatStatus } from "./status.js";

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

export interface Chat {
  id: string;
  /** `null` for standalone chats (they run in the scratch folder). */
  projectId: string | null;
  title: string;
  /** `auto` titles may be replaced by generated ones; `user` titles never are. */
  titleSource: "auto" | "user";
  /** Working directory the agent runs in. */
  cwd: string;
  /** Which harness owns this chat (e.g. "pi"). */
  harness: string;
  /** Harness specific reference to the persisted session (for pi: the session .jsonl path). */
  sessionRef: string | null;
  pinned: boolean;
  /** A run finished while the chat wasn't being viewed. */
  unread: boolean;
  /** The most recent run ended with an error or the agent crashed. Cleared when a new run starts. */
  lastRunFailed?: boolean;
  /** Position among the pinned chats of the same list (ascending). Only meaningful when pinned. */
  pinOrder?: number;
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

/** Chat plus runtime state that isn't persisted. */
export interface ChatSummary extends Chat {
  running: boolean;
  /** Open agent dialogs waiting for the user. */
  pendingInputs: number;
  /** Derived with `deriveChatStatus` - the single field the UI should use for indicators. */
  status: ChatStatus;
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
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export function defaultSettings(): Settings {
  return {
    general: {
      sendKey: "enter",
      busyBehavior: "steer",
      generateTitles: true,
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

/** `PUT /api/chats/pin-order`: the pinned chats of one list (a project, or standalone = null) in order. */
export interface ReorderPinnedChatsRequest {
  projectId: string | null;
  ids: string[];
}

/** Apps a project folder can be opened in (`POST /api/projects/:id/open`). */
export type OpenTarget = "vscode";

export interface OpenProjectRequest {
  app: OpenTarget;
}

export interface CreateChatRequest {
  projectId: string | null;
  /** Optional first prompt; sent right after the session starts. */
  prompt?: string;
  images?: PromptImage[];
  model?: ModelRef | null;
  thinkingLevel?: ThinkingLevel | null;
}

export interface UpdateChatRequest {
  title?: string;
  pinned?: boolean;
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

export interface ChatDetail {
  chat: ChatSummary;
  transcript: Transcript;
  state: SessionState;
  pendingUiRequests: import("./events.js").UiRequest[];
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
  | { type: "chat_event"; chatId: string; event: AgentEvent }
  | { type: "chat_upsert"; chat: ChatSummary }
  | { type: "chat_removed"; chatId: string }
  | { type: "project_upsert"; project: Project }
  | { type: "project_removed"; projectId: string }
  | { type: "settings"; settings: Settings }
  | { type: "models"; models: ModelInfo[] }
  /** Subscription usage limits; `null` when unavailable (feature hidden). */
  | { type: "usage_limits"; usage: UsageLimits | null };

/** Client -> server messages over the WebSocket. */
export type ClientMessage = { type: "viewing"; chatId: string | null };

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
}

export interface UsageLimits {
  /** Which account/provider these limits belong to, e.g. "Claude subscription". */
  source: string;
  limits: UsageLimit[];
  /** When the numbers were fetched (ms epoch). */
  fetchedAt: number;
  /** True when the last refresh failed/was skipped and these are older values. */
  stale: boolean;
}
