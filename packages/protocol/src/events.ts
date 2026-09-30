/**
 * Normalized agent events. Harness adapters emit these; the server forwards them to clients
 * (tagged with a chat id) and both sides fold them into a {@link Transcript} with
 * {@link applyAgentEvent}.
 */
import type { ModelRef, ThinkingLevel } from "./models.js";
import type { ChatMessage, ContentBlock, ShellResult, ToolInput, ToolResult } from "./transcript.js";

export interface SessionState {
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  /** Thinking levels supported by the current model. */
  thinkingLevels: ThinkingLevel[];
  isRunning: boolean;
  isCompacting: boolean;
  /** Messages queued while the agent is running. */
  queue: { steering: string[]; followUp: string[] };
  /**
   * Current context window usage. `tokens`/`percent` are `null` when unknown (e.g. right after
   * compaction, until the next reply).
   */
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  /** Whole-session totals (all turns, incl. compaction/summaries). */
  sessionStats?: SessionStats;
  /**
   * When the current run started (epoch ms, stamped by the server on `run_start`; I-070).
   * `null`/absent when idle or unknown.
   */
  runStartedAt?: number | null;
  /**
   * The chat's permission mode (I-174; harnesses with the `permissionModes` capability), one of
   * `permissionModes`' ids. Absent/null: the harness has no modes (or doesn't know it yet).
   */
  permissionMode?: string | null;
  /** The modes the chat can switch to, in the order Shift+Tab cycles them. Empty/absent: none. */
  permissionModes?: PermissionModeInfo[];
}

/**
 * A permission mode a harness offers (I-174), e.g. Claude Code's "Accept edits" or "Plan mode".
 * The UI shows `label` in the mode pill and cycles the list with Shift+Tab.
 */
export interface PermissionModeInfo {
  id: string;
  label: string;
  /** One line about what it does (menus and sheets). */
  description?: string;
  /** Dangerous (e.g. bypassing all permission checks): shown in red. */
  danger?: boolean;
}

export interface SessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  /** Total cost in USD (0 for subscription/local models that don't report cost). */
  cost: number;
}

export function defaultSessionState(): SessionState {
  return {
    model: null,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    isRunning: false,
    isCompacting: false,
    queue: { steering: [], followUp: [] },
  };
}

/** A blocking question from the agent (e.g. an extension asking to confirm a command). */
export type UiRequest =
  | { id: string; kind: "select"; title: string; options: string[]; timeoutMs?: number }
  | { id: string; kind: "confirm"; title: string; message?: string; timeoutMs?: number }
  | { id: string; kind: "input"; title: string; placeholder?: string; timeoutMs?: number }
  | { id: string; kind: "editor"; title: string; prefill?: string; timeoutMs?: number }
  /**
   * The agent asks before running a tool (ACP `session/request_permission`, I-119). Answered with
   * `{ id, value: option.id }`, or `{ id, cancelled: true }` (e.g. when the run is stopped).
   */
  | {
      id: string;
      kind: "permission";
      title: string;
      /** Details of the tool call (command, file…), when known. */
      message?: string;
      /** The tool call it's about, when it's in the transcript. */
      toolCallId?: string;
      options: PermissionOption[];
      /**
       * Show the options as a numbered list in the given order, like a terminal prompt (Claude
       * Code, I-174): keys 1–9 pick one. Absent: buttons, rejections first (ACP).
       */
      numbered?: boolean;
      /**
       * The option focused (↩ picks it); default the first "allow once". When it's a rejection the
       * number keys are off, so a stray key can't approve.
       */
      defaultOptionId?: string;
      timeoutMs?: number;
    };

/** One answer the agent offers to a {@link UiRequest} of kind `permission` (ACP's option kinds). */
export interface PermissionOption {
  id: string;
  label: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  /**
   * The agent stops and waits to be told what to do instead (Claude Code's "No, and tell Claude
   * what to do differently", I-174): the composer gets the focus after it's picked. Esc picks it.
   */
  focusComposer?: boolean;
}

export type UiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

export type AgentEvent =
  /** The agent started working on a prompt. */
  | { type: "run_start"; /** Epoch ms, stamped by the server (I-070). */ at?: number }
  /** The agent is fully idle again (no retries/queued work pending). */
  | { type: "run_end" }
  /** A new message was appended (user message, or an empty assistant message about to stream). */
  | { type: "message_start"; message: ChatMessage }
  /** A content block started streaming in the given message. */
  | { type: "block_start"; messageId: string; index: number; block: ContentBlock }
  /**
   * Text/thinking/tool-argument delta for a streaming block. For tool calls the adapter may add
   * the normalized input parsed so far (replaces the block's `input`; I-068).
   */
  | { type: "block_delta"; messageId: string; index: number; delta: string; input?: ToolInput }
  /** Final version of a block. */
  | { type: "block_end"; messageId: string; index: number; block: ContentBlock }
  /** Authoritative final version of a message. */
  | { type: "message_end"; message: ChatMessage }
  | {
      type: "tool_start";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown> | undefined;
      /** Epoch ms, stamped by the server (I-070). */
      at?: number;
    }
  | { type: "tool_update"; toolCallId: string; result: ToolResult }
  | { type: "tool_end"; toolCallId: string; result: ToolResult; /** Epoch ms, stamped by the server (I-070). */ at?: number }
  /**
   * A shell command the user ran (`!cmd` / `!!cmd`, I-076) started; it becomes a `ShellMessage`
   * with this id. Independent of runs (it can run while the agent works). `at`: epoch ms.
   */
  | { type: "shell_start"; id: string; command: string; shared: boolean; at?: number }
  /** More output of a running shell command (appended). */
  | { type: "shell_update"; id: string; delta: string }
  /** A shell command finished (or was stopped / failed to run). */
  | { type: "shell_end"; id: string; result: ShellResult; at?: number }
  /**
   * A side question (I-140) started; it becomes a `SideQuestionMessage` with this id. Glade's own
   * (never from the harness's session): the agent doesn't see it. `model`: `provider/id`.
   * `parentId` (I-156): a follow-up, appended to that card's `followUps` (its own `id` drives its
   * `side_delta`/`side_end`). `partialContext`: the answer only saw part of the chat.
   */
  | { type: "side_start"; id: string; question: string; model?: string; parentId?: string; partialContext?: boolean; at?: number }
  /** More of a side question's answer (appended). */
  | { type: "side_delta"; id: string; delta: string }
  /** A side question finished, was stopped or failed. `answer`: the final text, when known. */
  | { type: "side_end"; id: string; status: "done" | "stopped" | "error"; answer?: string; error?: string; at?: number }
  /** The user dismissed a side question's card (kept in the store, hidden). */
  | { type: "side_dismiss"; id: string }
  /** Partial session state change. */
  | { type: "state"; state: Partial<SessionState> }
  | { type: "ui_request"; request: UiRequest }
  /** A dialog was resolved elsewhere (or timed out). */
  | { type: "ui_request_closed"; id: string }
  /**
   * The session's slash commands changed (e.g. Codex reported new skills, I-185): clients that
   * loaded them (`GET /sessions/:id/commands`) load them again.
   */
  | { type: "commands_changed" }
  /** Transient toast-style notification. */
  | { type: "notify"; level: "info" | "warning" | "error"; message: string }
  /** The agent process failed / exited unexpectedly. */
  | { type: "error"; message: string };

export type AgentEventType = AgentEvent["type"];
