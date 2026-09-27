/**
 * Turns a transcript into render items for the chat view. Pure (no JSX, no signals) so the
 * rules are easy to test and to change in one place.
 *
 *   - Consecutive assistant messages form one "turn"; their content blocks are flattened
 *     into parts.
 *   - Consecutive tool calls inside a turn collapse into one `toolGroup` part (when there
 *     are at least `minGroupSize` of them). Whether thinking/text between calls breaks a
 *     group is configurable via {@link GroupingOptions}.
 *   - `task` calls (sub-agent spawns, I-084) are never grouped: they render as agent cards.
 *   - Empty text, and empty/redacted thinking, are dropped and never break a group.
 */
import type {
  AssistantMessage,
  ImageBlock,
  NoticeMessage,
  ShellMessage,
  ThinkingBlock,
  ToolCallBlock,
  ToolResult,
  Transcript,
  UserMessage,
} from "@glade/protocol";

export interface GroupingOptions {
  /** A visible thinking block between two tool calls ends the current group. */
  thinkingBreaksGroups: boolean;
  /** Visible text between two tool calls ends the current group. */
  textBreaksGroups: boolean;
  /** Runs of fewer consecutive tool calls than this are rendered as individual rows. */
  minGroupSize: number;
}

/** The one place to change how tool calls are grouped. */
export const DEFAULT_GROUPING_OPTIONS: GroupingOptions = {
  thinkingBreaksGroups: true,
  textBreaksGroups: true,
  minGroupSize: 2,
};

/**
 * Lifecycle of one tool call:
 *  - `streaming`: arguments are still being generated
 *  - `pending`:   arguments complete, execution not started yet
 *  - `running` / `done` / `error`: from the tool result
 *  - `cancelled`: never got a result and the run is over (aborted / failed)
 *  - `rejected`: the user said no when the agent asked for permission (I-119)
 */
export type ToolCallStatus = "streaming" | "pending" | "running" | "done" | "error" | "cancelled" | "rejected";

export interface ToolCallPart {
  type: "tool";
  key: string;
  call: ToolCallBlock;
  result: ToolResult | undefined;
  status: ToolCallStatus;
}

/** Things that can appear inside an expanded tool group. */
export type GroupItem = ToolCallPart | TextPart | ThinkingPart;

export interface ToolGroupPart {
  type: "toolGroup";
  key: string;
  calls: ToolCallPart[];
  /**
   * Calls plus any text/thinking that sat between them (only when those don't break
   * groups), in transcript order.
   */
  items: GroupItem[];
  /** True while any call in the group is streaming, pending or running. */
  active: boolean;
  errorCount: number;
}

export interface TextPart {
  type: "text";
  key: string;
  text: string;
  streaming: boolean;
}

export interface ThinkingPart {
  type: "thinking";
  key: string;
  text: string;
  streaming: boolean;
}

export interface ImagePart {
  type: "image";
  key: string;
  image: ImageBlock;
}

export interface ErrorPart {
  type: "error";
  key: string;
  /** `aborted` = the user stopped the run. */
  kind: "error" | "aborted";
  message: string;
  /** Raw provider error text, shown behind a "Details" disclosure. */
  details?: string;
}

export type TurnPart = TextPart | ThinkingPart | ImagePart | ToolCallPart | ToolGroupPart | ErrorPart;

export type RenderItem =
  | { type: "user"; key: string; message: UserMessage }
  | { type: "notice"; key: string; message: NoticeMessage }
  /** A shell command the user ran (`!cmd` / `!!cmd`, I-076). */
  | { type: "shell"; key: string; message: ShellMessage }
  /** `timestamp`: when the turn's first message started (I-111). */
  | { type: "turn"; key: string; parts: TurnPart[]; streaming: boolean; timestamp: number };

export interface GroupingContext {
  /** Whether the agent is currently running (decides between `pending` and `cancelled`). */
  isRunning: boolean;
}

export function isActiveStatus(status: ToolCallStatus): boolean {
  return status === "streaming" || status === "pending" || status === "running";
}

export function toolCallStatus(call: ToolCallBlock, result: ToolResult | undefined, isRunning: boolean): ToolCallStatus {
  if (result) return result.rejected ? "rejected" : result.status;
  if (!isRunning) return "cancelled";
  return call.args === undefined ? "streaming" : "pending";
}

export function groupTranscript(
  transcript: Transcript,
  context: GroupingContext,
  options: GroupingOptions = DEFAULT_GROUPING_OPTIONS,
): RenderItem[] {
  const items: RenderItem[] = [];
  let turn: AssistantMessage[] = [];

  const flush = () => {
    if (turn.length === 0) return;
    items.push({
      type: "turn",
      key: `turn-${turn[0]!.id}`,
      parts: buildTurnParts(turn, transcript.toolResults, context, options),
      streaming: turn.some((m) => m.streaming),
      timestamp: turn[0]!.timestamp,
    });
    turn = [];
  };

  for (const message of transcript.messages) {
    if (message.role === "assistant") {
      turn.push(message);
      continue;
    }
    flush();
    if (message.role === "user") items.push({ type: "user", key: message.id, message });
    else if (message.role === "shell") items.push({ type: "shell", key: message.id, message });
    else items.push({ type: "notice", key: message.id, message });
  }
  flush();
  return items;
}

/** Flatten a turn's messages into parts and collapse runs of tool calls. */
export function buildTurnParts(
  messages: readonly AssistantMessage[],
  toolResults: Transcript["toolResults"],
  context: GroupingContext,
  options: GroupingOptions = DEFAULT_GROUPING_OPTIONS,
): TurnPart[] {
  const parts: TurnPart[] = [];
  // The open run: tool calls plus any non-breaking text/thinking between them.
  let run: GroupItem[] = [];

  const flushRun = () => {
    // Non-tool parts after the last call aren't "between" calls; keep them outside the group.
    let end = run.length;
    while (end > 0 && run[end - 1]!.type !== "tool") end--;
    const body = run.slice(0, end);
    const trailing = run.slice(end);
    const calls = body.filter((p): p is ToolCallPart => p.type === "tool");
    if (calls.length > 0 && calls.length >= Math.max(1, options.minGroupSize)) {
      parts.push({
        type: "toolGroup",
        key: `group-${calls[0]!.key}`,
        calls,
        items: body,
        active: calls.some((c) => isActiveStatus(c.status)),
        errorCount: calls.filter((c) => c.status === "error").length,
      });
    } else {
      parts.push(...body);
    }
    parts.push(...trailing);
    run = [];
  };

  /** Add a text/thinking part: breaks the open run, or joins it if it doesn't break groups. */
  const addProse = (part: TextPart | ThinkingPart, breaks: boolean) => {
    if (breaks || run.length === 0) {
      flushRun();
      parts.push(part);
    } else {
      run.push(part);
    }
  };

  for (const message of messages) {
    const lastIndex = message.content.length - 1;
    message.content.forEach((block, index) => {
      const key = `${message.id}:${index}`;
      const streaming = !!message.streaming && index === lastIndex;
      switch (block.type) {
        case "toolCall": {
          const result = toolResults[block.id];
          if (block.kind === "task") {
            // A spawned sub-agent is a card of its own (I-084), never folded into a group.
            flushRun();
            parts.push({ type: "tool", key, call: block, result, status: toolCallStatus(block, result, context.isRunning) });
            return;
          }
          run.push({ type: "tool", key, call: block, result, status: toolCallStatus(block, result, context.isRunning) });
          return;
        }
        case "text":
          if (!block.text.trim()) return;
          addProse({ type: "text", key, text: block.text, streaming }, options.textBreaksGroups);
          return;
        case "thinking":
          if (!isVisibleThinking(block)) return;
          addProse({ type: "thinking", key, text: block.text, streaming }, options.thinkingBreaksGroups);
          return;
        case "image":
          flushRun();
          parts.push({ type: "image", key, image: block });
          return;
      }
    });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      flushRun();
      parts.push({
        type: "error",
        key: `${message.id}:error`,
        kind: message.stopReason,
        message: message.errorMessage ?? (message.stopReason === "aborted" ? "Stopped" : "Something went wrong"),
        ...(message.errorDetails ? { details: message.errorDetails } : {}),
      });
    }
  }
  flushRun();
  return parts;
}

function isVisibleThinking(block: ThinkingBlock): boolean {
  return !block.redacted && block.text.trim().length > 0;
}
