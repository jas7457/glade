/**
 * REST + WebSocket contract between the web client and the pi-ui server.
 */
import type { AgentEvent, SessionState, UiResponse } from "./events.js";
import type { ModelInfo, ModelRef, ThinkingLevel } from "./models.js";
import type { Transcript } from "./transcript.js";

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
  /** Absolute folder path on disk. Chats in this project run with this as cwd. */
  path: string;
  pinned: boolean;
  createdAt: number;
  /** Updated whenever one of its chats has activity. */
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
  archived: boolean;
  /** A run finished while the chat wasn't being viewed. */
  unread: boolean;
  createdAt: number;
  lastActivityAt: number;
  /** Last model / thinking level used, so re-opening restores them. */
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
}

/** Chat plus runtime state that isn't persisted. */
export interface ChatSummary extends Chat {
  running: boolean;
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
    /** System notification when a run finishes while the window is unfocused. */
    notifyOnComplete: boolean;
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
      notifyOnComplete: true,
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
  pinned?: boolean;
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
  archived?: boolean;
  unread?: boolean;
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

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
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
  | { type: "models"; models: ModelInfo[] };
