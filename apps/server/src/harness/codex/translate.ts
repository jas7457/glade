/**
 * Codex app-server notifications of one thread → Glade `AgentEvent`s (I-177). Pure; no I/O.
 *
 * - Items become blocks of an assistant message, in the order Codex starts them: reasoning
 *   (summary deltas, else raw reasoning text) → thinking, agent messages → text, tool items →
 *   tool calls (`tools.ts`). A text or reasoning item after a tool call opens the next assistant
 *   message (the previous one ends with `toolUse`), like a model's next response.
 * - Text and thinking blocks open lazily with their first text, so empty reasoning leaves nothing.
 *   `item/completed` carries the authoritative text.
 * - Tool calls start complete (`item/started` has the arguments); command output streams as
 *   `tool_update`s; `item/completed` ends them (exit code, diffs, MCP results, declines).
 * - `turn/plan/updated` is the plan card (one notice per turn, updated in place); context
 *   compaction and entering review mode are notices; a review's result (`exitedReviewMode`) is
 *   the reply text (Codex's agent message repeating it after that is skipped).
 * - `finish` ends the turn: it closes the message with the stop reason / error and settles tool
 *   calls that never completed.
 *
 * The user's prompt is added by the session (`userMessage`); Codex's `userMessage` items are not
 * shown again.
 */
import {
  applyAgentEvent,
  type AgentEvent,
  type AssistantMessage,
  type ImageBlock,
  type PlanEntry,
  type PromptImage,
  type StopReason,
  type TextBlock,
  type ToolResult,
  type Transcript,
} from "@glade/protocol";
import type { FileUpdateChange, ThreadItem, TurnPlanStep } from "./protocol.js";
import { codexDiff, codexToolCalls, fileCallId, mcpResultText, toolBlock, type CodexToolCall } from "./tools.js";

/** How a turn ended. */
export interface TurnEnd {
  stopReason: StopReason;
  errorMessage?: string;
  errorDetails?: string;
}

interface TextEntry {
  kind: "text" | "thinking";
  messageId: string;
  index: number | null;
  /** Reasoning: summary deltas were seen (raw reasoning text is then ignored). */
  summary?: boolean;
  /** Reasoning: the summary part being streamed (a new part starts a paragraph). */
  part?: number;
}

interface ToolEntry {
  call: CodexToolCall;
  messageId: string;
  index: number;
  output: string;
  ended: boolean;
}

export class CodexTranslator {
  private seq = 0;
  private current: AssistantMessage | null = null;
  private readonly texts = new Map<string, TextEntry>();
  private readonly tools = new Map<string, ToolEntry>();
  /** Items seen this turn (approvals point at them). */
  private readonly items = new Map<string, ThreadItem>();
  private readonly rejected = new Set<string>();
  private planId: string | null = null;
  /** A review's result was shown this turn; the agent messages after it repeat it. */
  private reviewShown = false;
  private readonly echoes = new Set<string>();

  constructor(
    /** Prefix for message ids, unique per session object so ids never clash with saved history. */
    private readonly prefix: string,
    private readonly now: () => number = Date.now,
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

  notice(kind: "info" | "warning" | "error" | "compaction", text: string): AgentEvent[] {
    return [{ type: "message_end", message: { id: this.nextId("n"), role: "notice", kind, text, timestamp: this.now() } }];
  }

  /** An item of this turn, by id (the latest version seen). */
  item(itemId: string): ThreadItem | undefined {
    return this.items.get(itemId);
  }

  /** The user said no to this item's approval: its calls end as rejected. */
  rejectTool(itemId: string): void {
    this.rejected.add(itemId);
  }

  /** Command items of this turn that haven't completed (still running when the turn is stopped). */
  runningCommands(): string[] {
    return [...this.tools].filter(([, t]) => t.call.name === "shell" && !t.ended).map(([id]) => id);
  }

  /** The id of the (first) tool call shown for an item. */
  toolCallId(itemId: string): string | undefined {
    const item = this.items.get(itemId);
    if (item?.type === "fileChange") return this.tools.has(fileCallId(itemId, 0)) ? fileCallId(itemId, 0) : undefined;
    return this.tools.has(itemId) ? itemId : undefined;
  }

  // Items ---------------------------------------------------------------------------------------

  itemStarted(item: ThreadItem): AgentEvent[] {
    this.items.set(item.id, item);
    switch (item.type) {
      case "userMessage":
        return [];
      case "agentMessage":
        if (this.isReviewEcho(item)) return [];
        return item.text ? this.setText(item.id, "text", item.text) : [];
      case "plan":
        return item.text ? this.setText(item.id, "text", item.text) : [];
      case "reasoning":
        return [];
      case "contextCompaction":
        return [];
      case "enteredReviewMode":
        return this.notice("info", `Reviewing: ${item.review}`);
      default:
        return this.startTools(codexToolCalls(item));
    }
  }

  itemCompleted(item: ThreadItem): AgentEvent[] {
    this.items.set(item.id, item);
    switch (item.type) {
      case "userMessage":
        return [];
      case "agentMessage":
        if (this.isReviewEcho(item)) return [];
        return this.setText(item.id, "text", item.text, true);
      case "plan":
        return this.setText(item.id, "text", item.text, true);
      case "reasoning": {
        const text = (item.summary.length ? item.summary : item.content).join("\n\n");
        return this.setText(item.id, "thinking", text, true);
      }
      case "contextCompaction":
        return this.notice("compaction", "Context compacted");
      case "exitedReviewMode":
        // The review is the turn's reply (I-178). Codex then records it as an agent message too
        // (the review's last item), which is skipped.
        if (!item.review?.trim()) return [];
        this.reviewShown = true;
        return this.setText(item.id, "text", item.review, true);
      case "enteredReviewMode":
        return [];
      default:
        return this.completeTools(item);
    }
  }

  agentDelta(itemId: string, delta: string): AgentEvent[] {
    if (this.echoes.has(itemId)) return [];
    return this.appendText(itemId, "text", delta);
  }

  reasoningSummaryDelta(itemId: string, delta: string, part: number): AgentEvent[] {
    const entry = this.texts.get(itemId);
    const events: AgentEvent[] = [];
    let text = delta;
    if (entry?.summary && entry.part !== undefined && part !== entry.part && entry.index !== null) text = `\n\n${delta}`;
    events.push(...this.appendText(itemId, "thinking", text));
    const e = this.texts.get(itemId);
    if (e) {
      e.summary = true;
      e.part = part;
    }
    return events;
  }

  reasoningTextDelta(itemId: string, delta: string): AgentEvent[] {
    if (this.texts.get(itemId)?.summary) return [];
    return this.appendText(itemId, "thinking", delta);
  }

  commandOutput(itemId: string, delta: string): AgentEvent[] {
    const tool = this.tools.get(itemId);
    if (!tool || tool.ended) return [];
    tool.output += delta;
    return [{ type: "tool_update", toolCallId: itemId, result: { toolCallId: itemId, toolName: tool.call.name, status: "running", output: tool.output } }];
  }

  /** The patch of a running file change was updated: newly listed files become calls. */
  patchUpdated(itemId: string, changes: FileUpdateChange[]): AgentEvent[] {
    const item = this.items.get(itemId);
    if (item?.type === "fileChange") this.items.set(itemId, { ...item, changes });
    const calls = codexToolCalls({ type: "fileChange", id: itemId, changes, status: "inProgress" }).filter((c) => !this.tools.has(c.id));
    return this.startTools(calls);
  }

  /** Codex's plan (`update_plan`): the plan card. */
  plan(steps: TurnPlanStep[], explanation?: string | null): AgentEvent[] {
    const entries: PlanEntry[] = steps.map((s) => ({ content: s.step, status: s.status === "inProgress" ? "in_progress" : s.status === "completed" ? "completed" : "pending" }));
    if (!entries.length && !this.planId) return [];
    this.planId ??= this.nextId("plan");
    const lines = entries.map((e) => `${e.status === "completed" ? "☑" : e.status === "in_progress" ? "▸" : "☐"} ${e.content}`);
    const head = explanation?.trim() ? `Plan: ${explanation.trim()}` : "Plan";
    return [{ type: "message_end", message: { id: this.planId, role: "notice", kind: "plan", text: `${head}\n${lines.join("\n")}`, plan: entries, timestamp: this.now() } }];
  }

  /** End the turn (see the header). */
  finish(end: TurnEnd): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [id, tool] of this.tools) {
      if (tool.ended) continue;
      tool.ended = true;
      const rejected = this.rejected.has(baseItemId(id));
      events.push({
        type: "tool_end",
        toolCallId: id,
        result: { toolCallId: id, toolName: tool.call.name, status: "error", output: rejected ? "" : tool.output || (end.stopReason === "aborted" ? "Stopped" : "Unfinished"), ...(rejected ? { rejected } : {}) },
      });
    }
    if (this.current || end.errorMessage) {
      if (!this.current) events.push(...this.open());
      const current = this.current!;
      events.push({
        type: "message_end",
        message: {
          ...current,
          streaming: false,
          stopReason: end.stopReason === "toolUse" ? "stop" : end.stopReason,
          ...(end.errorMessage ? { errorMessage: end.errorMessage } : {}),
          ...(end.errorDetails ? { errorDetails: end.errorDetails } : {}),
        },
      });
      this.current = null;
    }
    this.texts.clear();
    this.tools.clear();
    this.items.clear();
    this.rejected.clear();
    this.planId = null;
    this.reviewShown = false;
    this.echoes.clear();
    return events;
  }

  /** Codex's agent message repeating a review already shown (`exitedReviewMode`). */
  private isReviewEcho(item: { id: string }): boolean {
    if (this.echoes.has(item.id)) return true;
    if (!this.reviewShown) return false;
    this.echoes.add(item.id);
    return true;
  }

  // Blocks --------------------------------------------------------------------------------------

  private open(): AgentEvent[] {
    const message: AssistantMessage = { id: this.nextId("a"), role: "assistant", content: [], timestamp: this.now(), streaming: true };
    this.current = message;
    return [{ type: "message_start", message }];
  }

  private close(stopReason: StopReason): AgentEvent[] {
    const current = this.current;
    if (!current) return [];
    this.current = null;
    return [{ type: "message_end", message: { ...current, streaming: false, stopReason } }];
  }

  /** A message for a new text/thinking block: the next response after a tool call opens one. */
  private messageForText(): AgentEvent[] {
    if (this.current && this.current.content.at(-1)?.type !== "toolCall") return [];
    return [...this.close("toolUse"), ...this.open()];
  }

  private appendText(itemId: string, kind: "text" | "thinking", delta: string): AgentEvent[] {
    if (!delta) return [];
    const entry = this.texts.get(itemId);
    if (entry && entry.index !== null && this.current?.id === entry.messageId) {
      return this.apply({ type: "block_delta", messageId: entry.messageId, index: entry.index, delta });
    }
    if (entry && entry.index !== null) return []; // its message already ended
    const events = this.messageForText();
    const current = this.current!;
    const index = current.content.length;
    this.texts.set(itemId, { kind, messageId: current.id, index });
    events.push(...this.apply({ type: "block_start", messageId: current.id, index, block: { type: kind, text: delta.replace(/^\n\n/, "") } }));
    return events;
  }

  /** Set a text/thinking block to its full text (`final`: the item completed). */
  private setText(itemId: string, kind: "text" | "thinking", text: string, final = false): AgentEvent[] {
    const entry = this.texts.get(itemId);
    if (!entry) {
      if (!text) return [];
      const events = this.appendText(itemId, kind, text);
      const created = this.texts.get(itemId);
      if (final && created?.index !== null && created && this.current?.id === created.messageId) {
        events.push(...this.apply({ type: "block_end", messageId: created.messageId, index: created.index!, block: { type: kind, text } }));
      }
      return events;
    }
    if (entry.index === null || this.current?.id !== entry.messageId) return [];
    const shown = this.current.content[entry.index];
    const block = { type: kind, text: text || (shown && "text" in shown ? shown.text : "") } as const;
    return this.apply({ type: "block_end", messageId: entry.messageId, index: entry.index, block });
  }

  private startTools(calls: CodexToolCall[]): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const call of calls) {
      if (this.tools.has(call.id)) continue;
      if (!this.current) events.push(...this.open());
      const current = this.current!;
      const index = current.content.length;
      const block = toolBlock(call);
      events.push(
        ...this.apply({ type: "block_start", messageId: current.id, index, block }),
        ...this.apply({ type: "block_end", messageId: current.id, index, block }),
        { type: "tool_start", toolCallId: call.id, toolName: call.name, args: call.args },
      );
      this.tools.set(call.id, { call, messageId: current.id, index, output: "", ended: false });
    }
    return events;
  }

  private completeTools(item: ThreadItem): AgentEvent[] {
    const calls = codexToolCalls(item);
    const events = this.startTools(calls.filter((c) => !this.tools.has(c.id)));
    // The final arguments (a web search's query is only known at the end).
    for (const call of calls) {
      const tool = this.tools.get(call.id)!;
      if (JSON.stringify(tool.call) !== JSON.stringify(call)) {
        tool.call = call;
        if (this.current?.id === tool.messageId) events.push(...this.apply({ type: "block_end", messageId: tool.messageId, index: tool.index, block: toolBlock(call) }));
      }
    }
    const rejected = this.rejected.has(item.id);
    calls.forEach((call, i) => {
      const tool = this.tools.get(call.id)!;
      if (tool.ended) return;
      tool.ended = true;
      const result = this.result(item, call, tool, i, rejected);
      events.push({ type: "tool_end", toolCallId: call.id, result });
    });
    return events;
  }

  private result(item: ThreadItem, call: CodexToolCall, tool: ToolEntry, index: number, rejected: boolean): ToolResult {
    const base = { toolCallId: call.id, toolName: call.name };
    const declined = "status" in item && item.status === "declined";
    if (rejected || declined) return { ...base, status: "error", output: "", rejected: true };
    switch (item.type) {
      case "commandExecution": {
        const output = item.aggregatedOutput ?? tool.output;
        const failed = item.status === "failed" || (item.exitCode !== null && item.exitCode !== 0);
        const suffix = item.exitCode !== null && item.exitCode !== 0 ? `${output && !output.endsWith("\n") ? "\n" : ""}Exit code ${item.exitCode}` : "";
        return { ...base, status: failed ? "error" : "done", output: output + suffix, details: { exitCode: item.exitCode, durationMs: item.durationMs, cwd: item.cwd } };
      }
      case "fileChange": {
        const change = item.changes[index];
        const diff = change ? codexDiff(change) : undefined;
        const failed = item.status === "failed";
        return { ...base, status: failed ? "error" : "done", output: failed ? "The patch didn't apply" : "", ...(diff ? { diff } : {}) };
      }
      case "mcpToolCall":
        return item.error
          ? { ...base, status: "error", output: item.error.message }
          : { ...base, status: item.status === "failed" ? "error" : "done", output: mcpResultText(item.result?.content) };
      case "collabAgentToolCall": {
        // The sub-agents' last messages, when Codex has them.
        const messages = Object.values(item.agentsStates ?? {}).map((s) => s?.message?.trim()).filter(Boolean);
        return { ...base, status: item.status === "failed" ? "error" : "done", output: messages.join("\n\n") };
      }
      case "subAgentActivity":
        return { ...base, status: "done", output: "Codex's own sub-agent: its work isn't shown in Glade." };
      case "dynamicToolCall": {
        const text = (item.contentItems ?? []).map((c) => (c.type === "inputText" ? c.text : "")).filter(Boolean).join("\n");
        return { ...base, status: item.success === false || item.status === "failed" ? "error" : "done", output: text };
      }
      default:
        return { ...base, status: "done", output: tool.output };
    }
  }

  /** Emit an event and mirror it into the current message. */
  private apply(event: AgentEvent): AgentEvent[] {
    if (this.current && "messageId" in event && event.messageId === this.current.id) {
      const mini: Transcript = { messages: [this.current], toolResults: {} };
      this.current = applyAgentEvent(mini, event).messages[0] as AssistantMessage;
    }
    return [event];
  }
}

/** The item id of a tool call id (`<item>#<n>` for a file change's later files). */
function baseItemId(callId: string): string {
  const at = callId.lastIndexOf("#");
  return at > 0 ? callId.slice(0, at) : callId;
}
