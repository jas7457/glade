/**
 * Claude Agent SDK messages of one turn → Glade `AgentEvent`s (I-173). Pure; no I/O.
 *
 * - `stream_event`s (partial messages: `message_start`, `content_block_*`, `message_delta`) stream
 *   text, thinking and tool arguments into an assistant message (one per Anthropic message id).
 * - `assistant` messages are the authoritative content: their text/thinking blocks confirm the
 *   streamed ones in order (the SDK sends a message's blocks as they complete, often one per
 *   `assistant` message), tool calls by id; unseen blocks are added (no partial messages).
 * - A permission request can arrive before its tool call's message is read (`ensureTool` adds the
 *   call to a message that the next Anthropic message id then adopts).
 * - `user` messages with `tool_result` blocks end tool calls (diffs from `tool_use_result`). An
 *   assistant message ends when the next one starts (`toolUse` when it ended with a tool call).
 * - Sub-agent traffic (`parent_tool_use_id` set) is Claude's own Task/Agent tool at work: the
 *   session gives each sub-agent its own translator (`nested`) and shows it as a native
 *   sub-agent (I-188); the main translator skips it.
 * - TodoWrite / TaskCreate / TaskUpdate become one `plan` notice per turn, updated in place.
 *
 * The user's own prompt is added by the session (`userMessage`); Claude Code doesn't echo it.
 * `finish` ends the turn: it closes the streaming message with the turn's stop reason and settles
 * tool calls that never got a result.
 */
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
  type ToolResult,
  type Transcript,
  type Usage,
} from "@glade/protocol";
import type { ClaudeWire } from "./sdk.js";
import { claudePartialInput, claudeToolBlock, claudeToolDiff, isPlanTool, partialJsonArgs, toolResultContent } from "./tools.js";

type Json = Record<string, unknown>;

/** How a turn ended. */
export interface TurnEnd {
  stopReason: StopReason;
  errorMessage?: string;
  errorDetails?: string;
}

type BlockType = "text" | "thinking" | "tool";

interface Entry {
  type: BlockType;
  /** Index in the Glade message; `null` for hidden (plan) tools. */
  index: number | null;
  toolId?: string;
}

interface ApiMessage {
  gladeId: string;
  entries: Entry[];
  /** How many entries the `assistant` messages confirmed so far. */
  confirmed: number;
}

interface StreamBlock {
  entry: Entry;
  argsText: string;
}

interface ToolRecord {
  name: string;
  args: Json;
  hidden: boolean;
  /** Arguments are complete (block_end + tool_start sent). */
  final: boolean;
  ended: boolean;
  messageId: string;
  index: number | null;
}

interface Current {
  message: AssistantMessage;
  apiId: string | null;
  stopReason?: StopReason;
  error?: { message: string; details?: string };
}

const isJson = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Anthropic `stop_reason` → Glade's. */
export function mapStopReason(reason: unknown): StopReason | undefined {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn":
      return "stop";
    case "tool_use":
      return "toolUse";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "refusal":
      return "error";
    default:
      return undefined;
  }
}

/** Readable text for an assistant message's `error` (sign-in, limits, …). */
export function assistantErrorText(error: string, text: string): string {
  switch (error) {
    case "authentication_failed":
      return "Claude Code isn't logged in. Run `claude` in a terminal and log in (/login), then try again.";
    case "billing_error":
      return text || "Claude Code reported a billing problem with your account.";
    case "rate_limit":
      return text || "Claude's usage limit was reached. Try again later.";
    case "model_not_found":
      return text || "Claude Code doesn't know this model.";
    default:
      return text || `Claude Code reported an error (${error}).`;
  }
}

export class ClaudeTranslator {
  private seq = 0;
  private current: Current | null = null;
  /** The Anthropic message that started streaming (`message_start`) but has no block yet. */
  private pendingApiId: string | null = null;
  private readonly apiMessages = new Map<string, ApiMessage>();
  private readonly stream = new Map<number, StreamBlock>();
  private readonly tools = new Map<string, ToolRecord>();
  private readonly rejected = new Set<string>();
  private planId: string | null = null;
  private todos: PlanEntry[] | null = null;
  /** Claude Code's task list (TaskCreate/TaskUpdate), by task id, in creation order. */
  private readonly tasks = new Map<string, PlanEntry>();
  /** TaskCreate calls waiting for their result (which carries the new task's id). */
  private readonly creating = new Map<string, PlanEntry>();

  constructor(
    /** Prefix for message ids, unique per session object so ids never clash with saved history. */
    private readonly prefix: string,
    private readonly now: () => number = Date.now,
    /** A sub-agent's own translator (I-188): reads the messages with `parent_tool_use_id`. */
    private readonly nested = false,
  ) {}

  private nextId(kind: string): string {
    return `${this.prefix}-${kind}${this.seq++}`;
  }

  /** The user's prompt as a transcript message. */
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

  /** A notice in the transcript. */
  notice(kind: "info" | "warning" | "error" | "compaction", text: string): AgentEvent[] {
    return [{ type: "message_end", message: { id: this.nextId("n"), role: "notice", kind, text, timestamp: this.now() } }];
  }

  /** The user rejected the permission request for this tool call. */
  rejectTool(toolUseId: string): void {
    this.rejected.add(toolUseId);
  }

  /** Name and arguments of a tool call seen in this turn. */
  toolCall(toolUseId: string): { name: string; args: Json } | undefined {
    const tool = this.tools.get(toolUseId);
    return tool ? { name: tool.name, args: tool.args } : undefined;
  }

  /**
   * A tool call a permission request is about, added when the stream hasn't shown it yet (so the
   * permission card can point at it).
   */
  ensureTool(toolUseId: string, name: string, args: Json): AgentEvent[] {
    if (this.tools.has(toolUseId)) return [];
    const events: AgentEvent[] = [];
    if (!this.current) events.push(...this.open(null));
    events.push(...this.addTool(toolUseId, name, args));
    return events;
  }

  /** Translate one SDK message (stream events, assistant messages, tool results). */
  message(wire: ClaudeWire): AgentEvent[] {
    if (wire.parent_tool_use_id && !this.nested) return []; // a Task sub-agent's own traffic
    switch (wire.type) {
      case "stream_event":
        return isJson(wire.event) ? this.streamEvent(wire.event) : [];
      case "assistant":
        return this.assistant(wire);
      case "user":
        return this.toolResults(wire);
      default:
        return [];
    }
  }

  /** End the turn (see the header). */
  finish(end: TurnEnd): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [id, tool] of this.tools) {
      if (tool.ended || tool.hidden) continue;
      const rejected = this.rejected.has(id);
      events.push({
        type: "tool_end",
        toolCallId: id,
        result: {
          toolCallId: id,
          toolName: tool.name,
          status: "error",
          output: rejected ? "" : end.stopReason === "aborted" ? "Stopped" : "Unfinished",
          ...(rejected ? { rejected } : {}),
        },
      });
    }
    if (this.current || end.errorMessage) {
      if (!this.current) events.push(...this.open(null));
      const current = this.current!;
      const stopReason = end.stopReason === "stop" ? (current.error ? "error" : (current.stopReason ?? "stop")) : end.stopReason;
      const errorMessage = end.errorMessage ?? current.error?.message;
      const errorDetails = end.errorDetails ?? current.error?.details;
      events.push({
        type: "message_end",
        message: {
          ...current.message,
          streaming: false,
          stopReason: stopReason === "toolUse" ? "stop" : stopReason,
          ...(errorMessage ? { errorMessage } : {}),
          ...(errorDetails ? { errorDetails } : {}),
        },
      });
      this.current = null;
    }
    this.tools.clear();
    this.rejected.clear();
    this.apiMessages.clear();
    this.stream.clear();
    this.pendingApiId = null;
    this.creating.clear();
    this.planId = null;
    this.todos = null;
    return events;
  }

  // Stream events ---------------------------------------------------------------------------------

  private streamEvent(ev: Json): AgentEvent[] {
    switch (ev.type) {
      case "message_start": {
        const apiId = str((ev.message as Json | undefined)?.id) ?? null;
        // The message opens with its first block: a response that never streams content (a retry,
        // an empty turn) leaves no empty message behind.
        const events: AgentEvent[] = [];
        if (this.current && this.current.apiId === null && apiId !== null) this.adopt(apiId);
        else if (this.current && (apiId === null || this.current.apiId !== apiId)) events.push(...this.close());
        this.pendingApiId = this.current ? null : apiId;
        this.stream.clear();
        return events;
      }
      case "content_block_start":
        return this.blockStart(typeof ev.index === "number" ? ev.index : 0, isJson(ev.content_block) ? ev.content_block : {});
      case "content_block_delta":
        return this.blockDelta(typeof ev.index === "number" ? ev.index : 0, isJson(ev.delta) ? ev.delta : {});
      case "content_block_stop":
        return this.blockStop(typeof ev.index === "number" ? ev.index : 0);
      case "message_delta": {
        const reason = mapStopReason((ev.delta as Json | undefined)?.stop_reason);
        if (this.current && reason) this.current.stopReason = reason;
        return [];
      }
      default:
        return [];
    }
  }

  private blockStart(streamIndex: number, block: Json): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (!this.current) events.push(...this.open(this.pendingApiId));
    this.pendingApiId = null;
    const current = this.current!;
    const type = blockType(block);
    if (!type) return events;
    let entry: Entry;
    if (type === "tool") {
      const id = str(block.id) ?? this.nextId("t");
      const known = this.tools.get(id);
      // Known already: a permission request came first (`ensureTool`).
      entry = known ? { type: "tool", index: known.index, toolId: id } : this.startTool(id, str(block.name) ?? "tool", events);
    } else {
      const index = current.message.content.length;
      const initial: ContentBlock =
        type === "text"
          ? { type: "text", text: str(block.text) ?? "" }
          : block.type === "redacted_thinking"
            ? { type: "thinking", text: "", redacted: true }
            : { type: "thinking", text: str(block.thinking) ?? "" };
      events.push(...this.apply({ type: "block_start", messageId: current.message.id, index, block: initial }));
      entry = { type, index };
    }
    this.record(entry);
    this.stream.set(streamIndex, { entry, argsText: "" });
    return events;
  }

  private blockDelta(streamIndex: number, delta: Json): AgentEvent[] {
    const sb = this.stream.get(streamIndex);
    const current = this.current;
    if (!sb || !current) return [];
    const { entry } = sb;
    switch (delta.type) {
      case "text_delta":
      case "thinking_delta": {
        const text = str(delta.text) ?? str(delta.thinking) ?? "";
        if (!text || entry.index === null) return [];
        return this.apply({ type: "block_delta", messageId: current.message.id, index: entry.index, delta: text });
      }
      case "input_json_delta": {
        const part = str(delta.partial_json) ?? "";
        sb.argsText += part;
        const tool = entry.toolId ? this.tools.get(entry.toolId) : undefined;
        if (!tool || tool.hidden || entry.index === null || !part) return [];
        const input = claudePartialInput(tool.name, sb.argsText);
        return this.apply({ type: "block_delta", messageId: tool.messageId, index: entry.index, delta: part, ...(input ? { input } : {}) });
      }
      default:
        return [];
    }
  }

  private blockStop(streamIndex: number): AgentEvent[] {
    const sb = this.stream.get(streamIndex);
    const current = this.current;
    if (!sb || !current) return [];
    const { entry } = sb;
    if (entry.type === "tool" && entry.toolId) {
      const args = sb.argsText ? partialJsonArgs(sb.argsText) : {};
      return this.finalizeTool(entry.toolId, args);
    }
    if (entry.index === null) return [];
    const block = current.message.content[entry.index];
    return block ? this.apply({ type: "block_end", messageId: current.message.id, index: entry.index, block }) : [];
  }

  // Complete assistant messages ---------------------------------------------------------------

  private assistant(wire: ClaudeWire): AgentEvent[] {
    const msg = isJson(wire.message) ? wire.message : {};
    const apiId = str(msg.id) ?? null;
    const content = Array.isArray(msg.content) ? (msg.content as unknown[]).filter(isJson) : [];
    const events: AgentEvent[] = [];
    let rec = apiId ? this.apiMessages.get(apiId) : undefined;
    if (!rec && apiId && this.current && this.current.apiId === null) {
      this.adopt(apiId);
      rec = this.apiMessages.get(apiId);
    } else if (!rec) {
      events.push(...this.close());
      events.push(...this.open(apiId));
      rec = apiId ? this.apiMessages.get(apiId) : undefined;
    }
    // A late confirmation of a message that already ended (a newer one streams) only settles tools.
    const isCurrent = !rec || this.current?.message.id === rec.gladeId;
    for (const block of content) {
      const type = blockType(block);
      if (!type) {
        events.push(...this.serverToolResult(block));
        continue;
      }
      if (type === "tool") {
        // Tools are matched by id (a permission request may have added one before its message).
        const id = str(block.id) ?? this.nextId("t");
        const args = isJson(block.input) ? block.input : {};
        if (!this.tools.has(id)) {
          if (!this.current) events.push(...this.open(null));
          this.startTool(id, str(block.name) ?? "tool", events);
        }
        events.push(...this.finalizeTool(id, args));
        continue;
      }
      // Text and thinking: confirm the streamed blocks in order, or add them.
      const entry = rec?.entries[rec.confirmed];
      if (rec && entry && entry.type === type) {
        rec.confirmed++;
        if (entry.index !== null && isCurrent) {
          const authoritative = textBlock(block);
          const shown = this.current!.message.content[entry.index];
          if (authoritative && JSON.stringify(shown) !== JSON.stringify(authoritative)) {
            events.push(...this.apply({ type: "block_end", messageId: this.current!.message.id, index: entry.index, block: authoritative }));
          }
        }
        continue;
      }
      if (!isCurrent) continue;
      if (rec) rec.confirmed++;
      if (!this.current) events.push(...this.open(null));
      const current = this.current!;
      const authoritative = textBlock(block)!;
      const index = current.message.content.length;
      events.push(
        ...this.apply({ type: "block_start", messageId: current.message.id, index, block: authoritative }),
        ...this.apply({ type: "block_end", messageId: current.message.id, index, block: authoritative }),
      );
      this.record({ type, index });
    }
    if (!isCurrent || !this.current) return events;
    const current = this.current;
    if (typeof msg.model === "string" && msg.model !== "<synthetic>") current.message = { ...current.message, model: msg.model, provider: "anthropic" };
    const usage = usageOf(msg.usage);
    if (usage) current.message = { ...current.message, usage };
    const reason = mapStopReason(msg.stop_reason);
    if (reason) current.stopReason = reason;
    if (typeof wire.error === "string") {
      const text = content.map((b) => (b.type === "text" ? (str(b.text) ?? "") : "")).join("\n").trim();
      current.error = { message: assistantErrorText(wire.error, text), ...(text ? { details: text } : {}) };
    }
    return events;
  }

  /** A server tool's result block inside an assistant message (e.g. `web_search_tool_result`). */
  private serverToolResult(block: Json): AgentEvent[] {
    const id = str(block.tool_use_id);
    if (!id || !String(block.type).endsWith("_tool_result")) return [];
    const tool = this.tools.get(id);
    if (!tool || tool.ended) return [];
    tool.ended = true;
    const content = block.content;
    const output = Array.isArray(content)
      ? content
          .filter(isJson)
          .map((c) => [str(c.title), str(c.url)].filter(Boolean).join(" — "))
          .filter(Boolean)
          .join("\n")
      : toolResultContent(content).output;
    const failed = isJson(content) && typeof content.error_code === "string";
    return [{ type: "tool_end", toolCallId: id, result: { toolCallId: id, toolName: tool.name, status: failed ? "error" : "done", output } }];
  }

  // Tool results --------------------------------------------------------------------------------

  private toolResults(wire: ClaudeWire): AgentEvent[] {
    const msg = isJson(wire.message) ? wire.message : {};
    if (!Array.isArray(msg.content)) return [];
    const results = (msg.content as unknown[]).filter((b): b is Json => isJson(b) && b.type === "tool_result");
    if (!results.length) return [];
    // Results live in `toolResults`, not in the message list: the assistant message stays open
    // (Claude Code may run a tool while later blocks of the same message still stream).
    const events: AgentEvent[] = [];
    for (const block of results) {
      const id = str(block.tool_use_id);
      if (!id) continue;
      const tool = this.tools.get(id);
      if (tool?.hidden) {
        events.push(...this.planResult(id, tool, results.length === 1 ? wire.tool_use_result : undefined));
        continue;
      }
      if (tool) tool.ended = true;
      const name = tool?.name ?? "tool";
      const { output, images } = toolResultContent(block.content);
      const rejected = this.rejected.has(id);
      const diff = block.is_error ? undefined : claudeToolDiff(name, results.length === 1 ? wire.tool_use_result : undefined);
      const result: ToolResult = {
        toolCallId: id,
        toolName: name,
        status: block.is_error ? "error" : "done",
        output: rejected ? "" : output,
        ...(images ? { images } : {}),
        ...(diff ? { diff } : {}),
        ...(rejected ? { rejected } : {}),
      };
      events.push({ type: "tool_end", toolCallId: id, result });
    }
    return events;
  }

  // Tools -------------------------------------------------------------------------------------

  /** A new tool block (hidden for plan tools) in the current message; returns its entry. */
  private startTool(id: string, name: string, events: AgentEvent[]): Entry {
    const current = this.current!;
    if (isPlanTool(name)) {
      this.tools.set(id, { name, args: {}, hidden: true, final: false, ended: false, messageId: current.message.id, index: null });
      return { type: "tool", index: null, toolId: id };
    }
    const index = current.message.content.length;
    this.tools.set(id, { name, args: {}, hidden: false, final: false, ended: false, messageId: current.message.id, index });
    const block = { ...claudeToolBlock(id, name, {}), args: undefined, argsText: "" };
    delete (block as { input?: unknown }).input;
    events.push(...this.apply({ type: "block_start", messageId: current.message.id, index, block }));
    return { type: "tool", index, toolId: id };
  }

  /** Add a complete tool call (for {@link ensureTool}). */
  private addTool(id: string, name: string, args: Json): AgentEvent[] {
    const events: AgentEvent[] = [];
    this.startTool(id, name, events);
    events.push(...this.finalizeTool(id, args));
    return events;
  }

  /** The tool call's arguments are complete: the full block and `tool_start` (or the plan). */
  private finalizeTool(id: string, args: Json): AgentEvent[] {
    const tool = this.tools.get(id);
    if (!tool || tool.final) return [];
    tool.final = true;
    tool.args = args;
    if (tool.hidden) return this.planFromCall(id, tool);
    const block = claudeToolBlock(id, tool.name, args);
    return [
      ...this.apply({ type: "block_end", messageId: tool.messageId, index: tool.index!, block }),
      { type: "tool_start", toolCallId: id, toolName: tool.name, args },
    ];
  }

  // Plan ----------------------------------------------------------------------------------------

  private planFromCall(id: string, tool: ToolRecord): AgentEvent[] {
    const a = tool.args;
    switch (tool.name) {
      case "TodoWrite": {
        const todos = Array.isArray(a.todos) ? a.todos.filter(isJson) : [];
        this.todos = todos.map((t) => ({ content: str(t.content) ?? "", status: planStatus(t.status) }));
        return this.emitPlan();
      }
      case "TaskCreate":
        this.creating.set(id, { content: str(a.subject) ?? str(a.description) ?? "Task", status: "pending" });
        return [];
      case "TaskUpdate": {
        const taskId = str(a.taskId);
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (!taskId || !task) return [];
        if (a.status === "deleted") this.tasks.delete(taskId);
        else this.tasks.set(taskId, { content: str(a.subject) ?? task.content, status: a.status ? planStatus(a.status) : task.status });
        return this.emitPlan();
      }
      default:
        return [];
    }
  }

  private planResult(id: string, tool: ToolRecord, structured: unknown): AgentEvent[] {
    tool.ended = true;
    if (tool.name !== "TaskCreate") return [];
    const pending = this.creating.get(id);
    this.creating.delete(id);
    const task = isJson(structured) && isJson(structured.task) ? structured.task : undefined;
    const taskId = str(task?.id);
    if (!pending || !taskId) return [];
    this.tasks.set(taskId, { ...pending, content: str(task?.subject) ?? pending.content });
    return this.emitPlan();
  }

  private emitPlan(): AgentEvent[] {
    const entries = this.todos ?? [...this.tasks.values()];
    if (!entries.length && !this.planId) return [];
    this.planId ??= this.nextId("plan");
    const lines = entries.map((e) => `${e.status === "completed" ? "☑" : e.status === "in_progress" ? "▸" : "☐"} ${e.content}`);
    return [
      {
        type: "message_end",
        message: { id: this.planId, role: "notice", kind: "plan", text: `Plan\n${lines.join("\n")}`, plan: entries.map((e) => ({ ...e })), timestamp: this.now() },
      },
    ];
  }

  // Messages ------------------------------------------------------------------------------------

  /** Remember a streamed text/thinking block for the assistant message confirming it (tools match by id). */
  private record(entry: Entry): void {
    if (entry.type === "tool") return;
    const apiId = this.current?.apiId;
    if (apiId) this.apiMessages.get(apiId)?.entries.push(entry);
  }

  /** The streaming message (opened for a permission request) is Anthropic message `apiId`. */
  private adopt(apiId: string): void {
    const current = this.current!;
    current.apiId = apiId;
    const entries: Entry[] = [];
    current.message.content.forEach((b, index) => {
      if (b.type === "text" || b.type === "thinking") entries.push({ type: b.type, index });
    });
    this.apiMessages.set(apiId, { gladeId: current.message.id, entries, confirmed: 0 });
  }

  private open(apiId: string | null): AgentEvent[] {
    const message: AssistantMessage = { id: this.nextId("a"), role: "assistant", content: [], timestamp: this.now(), streaming: true };
    this.current = { message, apiId };
    if (apiId) this.apiMessages.set(apiId, { gladeId: message.id, entries: [], confirmed: 0 });
    return [{ type: "message_start", message }];
  }

  /** End the streaming message (`toolUse` when it ended with a tool call). */
  private close(fallback?: StopReason): AgentEvent[] {
    const current = this.current;
    if (!current) return [];
    this.current = null;
    const last = current.message.content.at(-1);
    const stopReason = current.error ? "error" : (current.stopReason ?? fallback ?? (last?.type === "toolCall" ? "toolUse" : "stop"));
    const message: AssistantMessage = {
      ...current.message,
      streaming: false,
      stopReason,
      ...(current.error ? { errorMessage: current.error.message, ...(current.error.details ? { errorDetails: current.error.details } : {}) } : {}),
    };
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

function blockType(block: Json): BlockType | null {
  switch (block.type) {
    case "text":
      return "text";
    case "thinking":
    case "redacted_thinking":
      return "thinking";
    case "tool_use":
    case "server_tool_use":
    case "mcp_tool_use":
      return "tool";
    default:
      return null;
  }
}

/** A complete text/thinking block from an assistant message. */
function textBlock(block: Json): ContentBlock | null {
  if (block.type === "text") return { type: "text", text: str(block.text) ?? "" };
  if (block.type === "thinking") return { type: "thinking", text: str(block.thinking) ?? "" };
  if (block.type === "redacted_thinking") return { type: "thinking", text: "", redacted: true };
  return null;
}

function planStatus(v: unknown): PlanEntry["status"] {
  return v === "completed" || v === "in_progress" ? v : "pending";
}

/** Anthropic usage → Glade's (no cost per message; the turn's result has the cost). */
export function usageOf(v: unknown): Usage | undefined {
  if (!isJson(v)) return undefined;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const input = n(v.input_tokens);
  const output = n(v.output_tokens);
  const cacheRead = n(v.cache_read_input_tokens);
  const cacheWrite = n(v.cache_creation_input_tokens);
  if (!input && !output && !cacheRead && !cacheWrite) return undefined;
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: 0 };
}
