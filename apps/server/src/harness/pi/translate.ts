/**
 * Pure translation from pi's RPC wire format to `@pi-ui/protocol` types.
 * Kept free of I/O so it can be tested against recorded fixtures.
 */
import {
  THINKING_LEVELS,
  type AgentEvent,
  type AssistantMessage,
  type ChatMessage,
  type ContentBlock,
  type ImageBlock,
  type ModelInfo,
  type SessionState,
  type StopReason,
  type ThinkingLevel,
  type ToolResult,
  type Transcript,
  type UiRequest,
  type Usage,
} from "@pi-ui/protocol";

// ---------------------------------------------------------------------------------------------
// Loose pi wire types (only the fields we read)
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

export interface PiModel {
  id: string;
  name?: string;
  provider: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  thinkingLevelMap?: Record<string, string | null>;
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

/** Mirrors pi-ai's `getSupportedThinkingLevels`. */
export function piThinkingLevels(model: PiModel): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function translateModel(model: PiModel): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    thinkingLevels: piThinkingLevels(model),
    input: (model.input ?? ["text"]).filter((i): i is "text" | "image" => i === "text" || i === "image"),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

export function translateState(data: Json): Partial<SessionState> {
  const model = data.model as PiModel | null | undefined;
  const state: Partial<SessionState> = {
    isRunning: Boolean(data.isStreaming),
    isCompacting: Boolean(data.isCompacting),
  };
  if (model !== undefined) {
    state.model = model ? { provider: model.provider, id: model.id } : null;
    state.thinkingLevels = model ? piThinkingLevels(model) : ["off"];
  }
  if (typeof data.thinkingLevel === "string") state.thinkingLevel = data.thinkingLevel as ThinkingLevel;
  return state;
}

// ---------------------------------------------------------------------------------------------
// Content + messages
// ---------------------------------------------------------------------------------------------

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is Json => typeof c === "object" && c !== null && (c as Json).type === "text")
    .map((c) => String(c.text ?? ""))
    .join("");
}

function imagesOf(content: unknown): ImageBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c): c is Json => typeof c === "object" && c !== null && (c as Json).type === "image")
    .map((c) => ({ type: "image", mimeType: String(c.mimeType ?? "image/png"), data: String(c.data ?? "") }));
}

export function translateBlock(raw: Json): ContentBlock | null {
  switch (raw.type) {
    case "text":
      return { type: "text", text: String(raw.text ?? "") };
    case "thinking": {
      const text = String(raw.thinking ?? "");
      return { type: "thinking", text, ...(text.length === 0 || raw.redacted ? { redacted: true } : {}) };
    }
    case "toolCall":
      return {
        type: "toolCall",
        id: String(raw.id),
        name: String(raw.name),
        args: (raw.arguments as Record<string, unknown> | undefined) ?? {},
      };
    case "image":
      return { type: "image", mimeType: String(raw.mimeType ?? "image/png"), data: String(raw.data ?? "") };
    default:
      return null;
  }
}

function translateUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Json;
  const cost = u.cost as Json | undefined;
  return {
    input: Number(u.input ?? 0),
    output: Number(u.output ?? 0),
    cacheRead: Number(u.cacheRead ?? 0),
    cacheWrite: Number(u.cacheWrite ?? 0),
    totalTokens: Number(u.totalTokens ?? 0),
    cost: Number(cost?.total ?? 0),
  };
}

/**
 * Translate a pi `AgentMessage` into a chat message. Returns `null` for messages that aren't
 * shown as their own entry (tool results are folded into `toolResults` instead).
 */
export function translateMessage(raw: Json, id: string): ChatMessage | null {
  const timestamp = Number(raw.timestamp ?? Date.now());
  switch (raw.role) {
    case "user": {
      const content: Array<{ type: "text"; text: string } | ImageBlock> = [];
      const text = textOf(raw.content);
      if (text) content.push({ type: "text", text });
      content.push(...imagesOf(raw.content));
      return { id, role: "user", content, timestamp };
    }
    case "assistant": {
      const content = Array.isArray(raw.content)
        ? (raw.content as Json[]).map(translateBlock).filter((b): b is ContentBlock => b !== null)
        : [];
      const message: AssistantMessage = {
        id,
        role: "assistant",
        content,
        timestamp,
        model: raw.model as string | undefined,
        provider: raw.provider as string | undefined,
        stopReason: raw.stopReason as StopReason | undefined,
        usage: translateUsage(raw.usage),
      };
      if (raw.errorMessage) message.errorMessage = String(raw.errorMessage);
      return message;
    }
    case "bashExecution":
      return {
        id,
        role: "notice",
        kind: "bash",
        text: `$ ${String(raw.command ?? "")}\n${String(raw.output ?? "")}`,
        timestamp,
      };
    case "compactionSummary":
      return { id, role: "notice", kind: "compaction", text: String(raw.summary ?? "Context compacted"), timestamp };
    case "custom":
      if (raw.display === false) return null;
      return { id, role: "notice", kind: "info", text: textOf(raw.content), timestamp };
    default:
      return null;
  }
}

export function translateToolResult(raw: Json, status?: ToolResult["status"]): ToolResult {
  return {
    toolCallId: String(raw.toolCallId),
    toolName: String(raw.toolName),
    status: status ?? (raw.isError ? "error" : "done"),
    output: textOf(raw.content),
    images: imagesOf(raw.content),
    details: raw.details,
  };
}

/** Build a transcript from the `get_messages` response. */
export function translateMessages(rawMessages: Json[], idFor: (index: number) => string): Transcript {
  const transcript: Transcript = { messages: [], toolResults: {} };
  rawMessages.forEach((raw, index) => {
    if (raw.role === "toolResult") {
      const result = translateToolResult(raw);
      transcript.toolResults[result.toolCallId] = result;
      return;
    }
    const message = translateMessage(raw, idFor(index));
    if (message) transcript.messages.push(message);
  });
  return transcript;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/**
 * Stateful translator for pi's event stream. pi messages carry no ids, so we assign them here
 * and remember which id belongs to the message currently streaming.
 */
export class PiEventTranslator {
  private counter = 0;
  /** role:timestamp -> id, so message_end maps to the id assigned at message_start. */
  private readonly ids = new Map<string, string>();
  private streamingAssistantId: string | null = null;

  constructor(private readonly prefix = "m") {}

  /** Continue numbering after an initial transcript load. */
  reserve(count: number): void {
    this.counter = Math.max(this.counter, count);
  }

  newId(): string {
    return `${this.prefix}${this.counter++}`;
  }

  private idForMessage(raw: Json, create: boolean): string {
    const key = `${String(raw.role)}:${String(raw.timestamp)}`;
    let id = this.ids.get(key);
    if (!id && create) {
      id = this.newId();
      this.ids.set(key, id);
    }
    return id ?? this.newId();
  }

  translate(event: Json): AgentEvent[] {
    switch (event.type) {
      case "agent_start":
        return [{ type: "run_start" }, { type: "state", state: { isRunning: true } }];

      case "agent_settled":
        this.streamingAssistantId = null;
        return [{ type: "run_end" }, { type: "state", state: { isRunning: false } }];

      case "message_start": {
        const raw = event.message as Json;
        if (raw.role === "toolResult") return [];
        const id = this.idForMessage(raw, true);
        const message = translateMessage(raw, id);
        if (!message) return [];
        if (message.role === "assistant") {
          this.streamingAssistantId = id;
          message.streaming = true;
        }
        return [{ type: "message_start", message }];
      }

      case "message_update":
        return this.translateUpdate(event.assistantMessageEvent as Json | undefined);

      case "message_end": {
        const raw = event.message as Json;
        if (raw.role === "toolResult") {
          const result = translateToolResult(raw);
          return [{ type: "tool_end", toolCallId: result.toolCallId, result }];
        }
        const id = this.idForMessage(raw, true);
        this.ids.delete(`${String(raw.role)}:${String(raw.timestamp)}`);
        if (raw.role === "assistant" && this.streamingAssistantId === id) this.streamingAssistantId = null;
        const message = translateMessage(raw, id);
        return message ? [{ type: "message_end", message }] : [];
      }

      case "tool_execution_start":
        return [
          {
            type: "tool_start",
            toolCallId: String(event.toolCallId),
            toolName: String(event.toolName),
            args: event.args as Record<string, unknown> | undefined,
          },
        ];

      case "tool_execution_update": {
        const partial = (event.partialResult as Json | undefined) ?? {};
        return [
          {
            type: "tool_update",
            toolCallId: String(event.toolCallId),
            result: translateToolResult(
              { ...partial, toolCallId: event.toolCallId, toolName: event.toolName },
              "running",
            ),
          },
        ];
      }

      case "tool_execution_end": {
        const result = (event.result as Json | undefined) ?? {};
        return [
          {
            type: "tool_end",
            toolCallId: String(event.toolCallId),
            result: translateToolResult({
              ...result,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError: event.isError,
            }),
          },
        ];
      }

      case "queue_update":
        return [
          {
            type: "state",
            state: {
              queue: {
                steering: (event.steering as string[] | undefined) ?? [],
                followUp: (event.followUp as string[] | undefined) ?? [],
              },
            },
          },
        ];

      case "compaction_start":
        return [{ type: "state", state: { isCompacting: true } }];

      case "compaction_end": {
        const out: AgentEvent[] = [{ type: "state", state: { isCompacting: false } }];
        if (event.errorMessage) {
          out.push({ type: "notify", level: "error", message: `Compaction failed: ${String(event.errorMessage)}` });
        } else if (!event.aborted) {
          out.push({ type: "notify", level: "info", message: "Context compacted" });
        }
        return out;
      }

      case "auto_retry_start":
        return [
          {
            type: "notify",
            level: "warning",
            message: `Retrying (${String(event.attempt)}/${String(event.maxAttempts)}): ${String(event.errorMessage ?? "")}`.trim(),
          },
        ];

      case "auto_retry_end":
        return event.success
          ? []
          : [{ type: "notify", level: "error", message: `Request failed: ${String(event.finalError ?? "unknown error")}` }];

      case "extension_error":
        return [{ type: "notify", level: "error", message: `Extension error: ${String(event.error ?? "")}` }];

      case "extension_ui_request":
        return this.translateUiRequest(event);

      default:
        return [];
    }
  }

  private translateUpdate(update: Json | undefined): AgentEvent[] {
    const messageId = this.streamingAssistantId;
    if (!update || !messageId) return [];
    const index = Number(update.contentIndex ?? 0);
    switch (update.type) {
      case "text_start":
        return [{ type: "block_start", messageId, index, block: { type: "text", text: "" } }];
      case "thinking_start":
        return [{ type: "block_start", messageId, index, block: { type: "thinking", text: "" } }];
      case "toolcall_start":
        return [
          {
            type: "block_start",
            messageId,
            index,
            block: { type: "toolCall", id: String(update.id), name: String(update.toolName), args: undefined },
          },
        ];
      case "text_delta":
      case "thinking_delta":
      case "toolcall_delta": {
        const delta = String(update.delta ?? "");
        return delta ? [{ type: "block_delta", messageId, index, delta }] : [];
      }
      case "text_end":
        return [{ type: "block_end", messageId, index, block: { type: "text", text: String(update.content ?? "") } }];
      case "thinking_end": {
        const text = String(update.content ?? "");
        return [
          {
            type: "block_end",
            messageId,
            index,
            block: { type: "thinking", text, ...(text ? {} : { redacted: true }) },
          },
        ];
      }
      case "toolcall_end": {
        const block = translateBlock((update.toolCall as Json | undefined) ?? {});
        return block ? [{ type: "block_end", messageId, index, block }] : [];
      }
      default:
        return [];
    }
  }

  private translateUiRequest(event: Json): AgentEvent[] {
    const id = String(event.id);
    const timeoutMs = typeof event.timeout === "number" ? event.timeout : undefined;
    const title = String(event.title ?? "");
    let request: UiRequest | null = null;
    switch (event.method) {
      case "select":
        request = { id, kind: "select", title, options: (event.options as string[]) ?? [], timeoutMs };
        break;
      case "confirm":
        request = { id, kind: "confirm", title, message: event.message as string | undefined, timeoutMs };
        break;
      case "input":
        request = { id, kind: "input", title, placeholder: event.placeholder as string | undefined, timeoutMs };
        break;
      case "editor":
        request = { id, kind: "editor", title, prefill: event.prefill as string | undefined, timeoutMs };
        break;
      case "notify":
        return [
          {
            type: "notify",
            level: (event.notifyType as "info" | "warning" | "error" | undefined) ?? "info",
            message: String(event.message ?? ""),
          },
        ];
      default:
        // setStatus / setWidget / setTitle / set_editor_text are TUI niceties; ignored for now.
        return [];
    }
    return [{ type: "ui_request", request }];
  }
}
