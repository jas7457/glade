/**
 * ACP `session/update`s of one prompt turn → Glade `AgentEvent`s (I-119).
 *
 * - `agent_message_chunk` / `agent_thought_chunk` stream into text / thinking blocks of the
 *   current assistant message (created on demand). A chunk after a tool call, or with a new ACP
 *   `messageId`, starts a new assistant message (pi's shape: text + tool calls, then results,
 *   then the next message), ending the previous one with `toolUse`.
 * - `tool_call` adds a normalized tool block (`tools.ts`) + `tool_start`; `tool_call_update`
 *   re-sends the block when its title/kind/input changed and the result as `tool_update` /
 *   `tool_end` (completed → done, failed → error).
 * - `plan` becomes one `plan` notice (a checklist) per turn, updated in place.
 * - Everything else (commands, modes, usage, config options, session info) is the session's
 *   business (`acp-session.ts`); `user_message_chunk` only occurs in history replays, which Glade
 *   ignores (it keeps its own copy of the transcript).
 *
 * `finish` ends the turn with the prompt's stop reason.
 */
import type { ContentBlock as AcpContentBlock, Plan, SessionUpdate, StopReason as AcpStopReason, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk";
import {
  applyAgentEvent,
  type AgentEvent,
  type AssistantMessage,
  type ContentBlock,
  type ImageBlock,
  type PlanEntry,
  type PromptImage,
  type StopReason,
  type TextBlock,
  type Transcript,
} from "@glade/protocol";
import { acpToolBlock, acpToolResult, mergeToolUpdate, newToolState, type AcpToolState } from "./tools.js";

interface ToolEntry {
  state: AcpToolState;
  messageId: string;
  index: number;
  /** JSON of the last block sent, to skip unchanged re-sends. */
  sent: string;
}

/** How a turn ended: an ACP stop reason, or a failed `session/prompt` request. */
export type TurnEnd = { stopReason: AcpStopReason } | { error: string; details?: string };

export class AcpTranslator {
  private seq = 0;
  /** The assistant message being streamed (mirrored locally to send complete `message_end`s). */
  private current: { message: AssistantMessage; acpMessageId: string | null } | null = null;
  private readonly tools = new Map<string, ToolEntry>();
  private planId: string | null = null;
  /** Tool calls the user rejected in the permission card: they fail as "rejected", not as errors. */
  private readonly rejected = new Set<string>();

  constructor(
    /** Prefix for message ids, unique per agent process so ids never clash with saved history. */
    private readonly prefix: string,
    private readonly now: () => number = Date.now,
  ) {}

  private nextId(kind: string): string {
    return `${this.prefix}-${kind}${this.seq++}`;
  }

  /** The user's prompt as a transcript message (Glade shows it; ACP agents don't echo it). */
  userMessage(text: string, images: PromptImage[] = []): AgentEvent[] {
    const content: Array<TextBlock | ImageBlock> = [];
    if (text) content.push({ type: "text", text });
    for (const image of images) content.push({ type: "image", mimeType: image.mimeType, data: image.data });
    const message = { id: this.nextId("u"), role: "user" as const, content, timestamp: this.now() };
    return [
      { type: "message_start", message },
      { type: "message_end", message },
    ];
  }

  /** A notice in the transcript (warnings, "the agent started a new session", …). */
  notice(kind: "info" | "warning" | "error", text: string): AgentEvent[] {
    return [...this.closeMessage(), { type: "message_end", message: { id: this.nextId("n"), role: "notice", kind, text, timestamp: this.now() } }];
  }

  /** Translate one `session/update` of the running turn. */
  update(update: SessionUpdate): AgentEvent[] {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        return this.chunk("text", update.content, update.messageId ?? null);
      case "agent_thought_chunk":
        return this.chunk("thinking", update.content, update.messageId ?? null);
      case "tool_call":
        return this.toolCall(update);
      case "tool_call_update":
        return this.toolCallUpdate(update);
      case "plan":
        return this.plan(update);
      default:
        return [];
    }
  }

  /**
   * The tool call a permission request is about: ACP agents usually announce it first with
   * `tool_call`, but the request carries it too (as an update), so an unknown one is added.
   */
  permissionToolCall(toolCall: ToolCallUpdate): AgentEvent[] {
    return this.toolCallUpdate(toolCall);
  }

  /** The user rejected the permission request for this tool call. */
  rejectTool(toolCallId: string): void {
    this.rejected.add(toolCallId);
  }

  /** What's known about a tool call (for the permission card). */
  toolState(toolCallId: string): AcpToolState | undefined {
    return this.tools.get(toolCallId)?.state;
  }

  /** End the turn: close the streaming message with the stop reason, settle unfinished tools. */
  finish(end: TurnEnd): AgentEvent[] {
    const events: AgentEvent[] = [];
    let stopReason: StopReason;
    let errorMessage: string | undefined;
    let errorDetails: string | undefined;
    if ("error" in end) {
      stopReason = "error";
      errorMessage = end.error;
      errorDetails = end.details;
    } else {
      switch (end.stopReason) {
        case "end_turn":
          stopReason = "stop";
          break;
        case "max_tokens":
          stopReason = "length";
          break;
        case "max_turn_requests":
          stopReason = "stop";
          break;
        case "refusal":
          stopReason = "error";
          errorMessage = "The agent refused to continue.";
          break;
        case "cancelled":
          stopReason = "aborted";
          break;
        default:
          stopReason = "stop";
      }
    }
    for (const [id, tool] of this.tools) {
      if (tool.state.status === "completed" || tool.state.status === "failed") continue;
      const result = acpToolResult(tool.state);
      const rejected = this.rejected.has(id);
      events.push({
        type: "tool_end",
        toolCallId: id,
        result: { ...result, status: "error", output: result.output || (rejected ? "" : stopReason === "aborted" ? "Stopped" : "Unfinished"), ...(rejected ? { rejected } : {}) },
      });
    }
    this.tools.clear();
    this.rejected.clear();
    if (this.current || errorMessage) {
      const message = this.current?.message ?? { id: this.nextId("a"), role: "assistant" as const, content: [], timestamp: this.now() };
      if (!this.current) events.push({ type: "message_start", message: { ...message, streaming: true } });
      events.push({
        type: "message_end",
        message: { ...message, streaming: false, stopReason, ...(errorMessage ? { errorMessage } : {}), ...(errorDetails ? { errorDetails } : {}) },
      });
      this.current = null;
    }
    if (!("error" in end) && end.stopReason === "max_turn_requests") {
      events.push(...this.notice("warning", "The agent stopped: it reached its limit of model requests for this turn."));
    }
    this.planId = null;
    return events;
  }

  // -------------------------------------------------------------------------------------------

  private chunk(kind: "text" | "thinking", content: AcpContentBlock, acpMessageId: string | null): AgentEvent[] {
    const events: AgentEvent[] = [];
    const last = this.current?.message.content.at(-1);
    const newMessage =
      !this.current || last?.type === "toolCall" || (acpMessageId !== null && this.current.acpMessageId !== null && acpMessageId !== this.current.acpMessageId);
    if (newMessage) events.push(...this.closeMessage(last?.type === "toolCall" ? "toolUse" : undefined), ...this.openMessage(acpMessageId));
    const current = this.current!;
    if (acpMessageId && !current.acpMessageId) current.acpMessageId = acpMessageId;
    const messageId = current.message.id;

    if (content.type === "image") {
      const block: ImageBlock = { type: "image", mimeType: content.mimeType, data: content.data };
      const index = current.message.content.length;
      events.push(...this.apply({ type: "block_start", messageId, index, block }), ...this.apply({ type: "block_end", messageId, index, block }));
      return events;
    }
    const text = chunkText(content);
    if (!text) return events;
    const tail = current.message.content.at(-1);
    let index = current.message.content.length - 1;
    if (tail?.type !== kind) {
      index = current.message.content.length;
      const block: ContentBlock = kind === "text" ? { type: "text", text: "" } : { type: "thinking", text: "" };
      events.push(...this.apply({ type: "block_start", messageId, index, block }));
    }
    events.push(...this.apply({ type: "block_delta", messageId, index, delta: text }));
    return events;
  }

  private toolCall(call: ToolCall): AgentEvent[] {
    if (this.tools.has(call.toolCallId)) return this.toolCallUpdate(call);
    const events: AgentEvent[] = [];
    if (!this.current) events.push(...this.openMessage(null));
    const state = newToolState(call);
    const current = this.current!;
    const index = current.message.content.length;
    const block = acpToolBlock(state);
    const entry: ToolEntry = { state, messageId: current.message.id, index, sent: JSON.stringify(block) };
    this.tools.set(call.toolCallId, entry);
    events.push(
      ...this.apply({ type: "block_start", messageId: entry.messageId, index, block }),
      ...this.apply({ type: "block_end", messageId: entry.messageId, index, block }),
      { type: "tool_start", toolCallId: call.toolCallId, toolName: block.name, args: block.args },
    );
    events.push(...this.result(entry));
    return events;
  }

  private toolCallUpdate(update: ToolCallUpdate): AgentEvent[] {
    const entry = this.tools.get(update.toolCallId);
    if (!entry) return this.toolCall({ ...update, title: update.title ?? "Tool call" } as ToolCall);
    entry.state = mergeToolUpdate(entry.state, update);
    const events: AgentEvent[] = [];
    const block = acpToolBlock(entry.state);
    const json = JSON.stringify(block);
    if (json !== entry.sent) {
      entry.sent = json;
      events.push(...this.apply({ type: "block_end", messageId: entry.messageId, index: entry.index, block }));
    }
    events.push(...this.result(entry));
    return events;
  }

  private result(entry: ToolEntry): AgentEvent[] {
    let result = acpToolResult(entry.state);
    if (result.status === "error" && this.rejected.has(entry.state.toolCallId)) result = { ...result, rejected: true };
    if (result.status === "running") return result.output || result.images ? [{ type: "tool_update", toolCallId: entry.state.toolCallId, result }] : [];
    return [{ type: "tool_end", toolCallId: entry.state.toolCallId, result }];
  }

  private plan(plan: Plan): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (!this.planId) {
      events.push(...this.closeMessage());
      this.planId = this.nextId("plan");
    }
    const entries: PlanEntry[] = plan.entries.map((e) => ({ content: e.content, status: e.status }));
    const lines = entries.map((e) => `${e.status === "completed" ? "☑" : e.status === "in_progress" ? "▸" : "☐"} ${e.content}`);
    events.push({
      type: "message_end",
      message: { id: this.planId, role: "notice", kind: "plan", text: `Plan\n${lines.join("\n")}`, plan: entries, timestamp: this.now() },
    });
    return events;
  }

  private openMessage(acpMessageId: string | null): AgentEvent[] {
    const message: AssistantMessage = { id: this.nextId("a"), role: "assistant", content: [], timestamp: this.now(), streaming: true };
    this.current = { message, acpMessageId };
    return [{ type: "message_start", message }];
  }

  private closeMessage(stopReason?: StopReason): AgentEvent[] {
    if (!this.current) return [];
    const message: AssistantMessage = { ...this.current.message, streaming: false, ...(stopReason ? { stopReason } : {}) };
    this.current = null;
    return [{ type: "message_end", message }];
  }

  /** Emit an event and mirror it into the current message. */
  private apply(event: AgentEvent): AgentEvent[] {
    if (this.current && "messageId" in event && event.messageId === this.current.message.id) {
      const mini: Transcript = { messages: [this.current.message], toolResults: {} };
      this.current.message = applyAgentEvent(mini, event).messages[0] as AssistantMessage;
    }
    return [event];
  }
}

/** Text of a chunk's content block (resource links as their URI, embedded text resources inline). */
function chunkText(content: AcpContentBlock): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "resource_link":
      return content.title ?? content.name ?? content.uri;
    case "resource":
      return "text" in content.resource ? content.resource.text : "";
    default:
      return "";
  }
}
