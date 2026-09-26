/**
 * Normalized agent events. Harness adapters emit these; the server forwards them to clients
 * (tagged with a chat id) and both sides fold them into a {@link Transcript} with
 * {@link applyAgentEvent}.
 */
import type { ModelRef, ThinkingLevel } from "./models.js";
import type { ChatMessage, ContentBlock, ToolResult } from "./transcript.js";

export interface SessionState {
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  /** Thinking levels supported by the current model. */
  thinkingLevels: ThinkingLevel[];
  isRunning: boolean;
  isCompacting: boolean;
  /** Messages queued while the agent is running. */
  queue: { steering: string[]; followUp: string[] };
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
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
  | { id: string; kind: "editor"; title: string; prefill?: string; timeoutMs?: number };

export type UiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

export type AgentEvent =
  /** The agent started working on a prompt. */
  | { type: "run_start" }
  /** The agent is fully idle again (no retries/queued work pending). */
  | { type: "run_end" }
  /** A new message was appended (user message, or an empty assistant message about to stream). */
  | { type: "message_start"; message: ChatMessage }
  /** A content block started streaming in the given message. */
  | { type: "block_start"; messageId: string; index: number; block: ContentBlock }
  /** Text/thinking/tool-argument delta for a streaming block. */
  | { type: "block_delta"; messageId: string; index: number; delta: string }
  /** Final version of a block. */
  | { type: "block_end"; messageId: string; index: number; block: ContentBlock }
  /** Authoritative final version of a message. */
  | { type: "message_end"; message: ChatMessage }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: Record<string, unknown> | undefined }
  | { type: "tool_update"; toolCallId: string; result: ToolResult }
  | { type: "tool_end"; toolCallId: string; result: ToolResult }
  /** Partial session state change. */
  | { type: "state"; state: Partial<SessionState> }
  | { type: "ui_request"; request: UiRequest }
  /** A dialog was resolved elsewhere (or timed out). */
  | { type: "ui_request_closed"; id: string }
  /** Transient toast-style notification. */
  | { type: "notify"; level: "info" | "warning" | "error"; message: string }
  /** The agent process failed / exited unexpectedly. */
  | { type: "error"; message: string };

export type AgentEventType = AgentEvent["type"];
