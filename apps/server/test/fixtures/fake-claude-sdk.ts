/**
 * A scripted fake of the Claude Agent SDK (`ClaudeSdk`, I-173) for tests: no CLI, no model.
 * Each `query()` becomes a {@link FakeQuery}; the test's `onUser` handler reacts to the user
 * messages Glade writes (emit stream events, assistant messages, results; call `canUseTool`).
 *
 *   const sdk = new FakeClaudeSdk({ onUser: (q, msg) => q.reply("Hello") });
 */
import type { ClaudeInitResult, ClaudeMcpToolSpec, ClaudeOptions, ClaudeQuery, ClaudeQueryParams, ClaudeSdk, ClaudeSlashCommand, ClaudeUserInput, ClaudeWire } from "../../src/harness/claude/sdk.js";

export const FAKE_INIT: ClaudeInitResult = {
  commands: [{ name: "review", description: "Review the changes", argumentHint: "[focus]" }],
  models: [
    { value: "default", displayName: "Default (recommended)", description: "Sonnet", resolvedModel: "claude-sonnet-5" },
    { value: "sonnet", displayName: "Sonnet", resolvedModel: "claude-sonnet-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"], supportsAdaptiveThinking: true },
    { value: "haiku", displayName: "Haiku", resolvedModel: "claude-haiku-4-5" },
  ],
};

let msgSeq = 0;

export class FakeQuery implements ClaudeQuery {
  private readonly out: ClaudeWire[] = [];
  private waiting: ((r: IteratorResult<ClaudeWire>) => void) | null = null;
  private waitingError: ((err: Error) => void) | null = null;
  private ended = false;
  private error: Error | null = null;
  closed = false;
  interrupts = 0;
  readonly received: ClaudeUserInput[] = [];

  constructor(
    readonly params: ClaudeQueryParams,
    private readonly sdk: FakeClaudeSdk,
  ) {
    const prompt = params.prompt;
    if (typeof prompt !== "string") {
      void (async () => {
        for await (const message of prompt) {
          this.received.push(message);
          void this.sdk.options.onUser?.(this, message);
        }
      })();
    } else {
      void Promise.resolve().then(() => this.sdk.options.onString?.(this, prompt));
    }
  }

  get options(): ClaudeOptions {
    return this.params.options;
  }

  /** Text of the n-th user message received. */
  text(n = -1): string {
    const content = this.received.at(n)?.message.content;
    if (typeof content === "string") return content;
    return (content ?? []).map((b) => (typeof b.text === "string" ? b.text : "")).join("");
  }

  emit(...messages: ClaudeWire[]): void {
    for (const message of messages) {
      if (this.ended) return;
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        this.waitingError = null;
        resolve({ value: message, done: false });
      } else {
        this.out.push(message);
      }
    }
  }

  /** A whole streamed text reply (stream events + the assistant message) and its result. */
  reply(text: string, extra: { usage?: Record<string, number>; cost?: number } = {}): void {
    const id = `msg_${++msgSeq}`;
    const half = Math.ceil(text.length / 2);
    this.emit(
      { type: "system", subtype: "init", model: "claude-sonnet-5", session_id: "s" },
      stream({ type: "message_start", message: { id } }),
      stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, half) } }),
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(half) } }),
      stream({ type: "content_block_stop", index: 0 }),
      assistant(id, [{ type: "text", text }], extra.usage),
      stream({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      stream({ type: "message_stop" }),
      result({ cost: extra.cost ?? 0.001 }),
    );
  }

  /** End the stream (an error makes the iterator throw: a crash). */
  end(error?: Error): void {
    this.ended = true;
    if (error) this.error = error;
    if (this.waiting) {
      const resolve = this.waiting;
      const reject = this.waitingError;
      this.waiting = null;
      this.waitingError = null;
      if (error) reject?.(error);
      else resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeWire> {
    return {
      next: () => {
        const item = this.out.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return this.error ? Promise.reject(this.error) : Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiting = resolve;
          this.waitingError = reject;
        });
      },
    };
  }

  async interrupt(): Promise<unknown> {
    this.interrupts++;
    await this.sdk.options.onInterrupt?.(this);
    return undefined;
  }

  async setModel(): Promise<void> {}

  async initializationResult(): Promise<ClaudeInitResult> {
    return this.sdk.init;
  }

  async supportedCommands(): Promise<ClaudeSlashCommand[]> {
    return this.sdk.init.commands;
  }

  close(): void {
    this.closed = true;
    this.end();
  }

  /** Ask for permission like Claude Code does (`canUseTool`). */
  canUseTool(toolName: string, input: Record<string, unknown>, toolUseID: string, extra: Record<string, unknown> = {}) {
    const controller = new AbortController();
    return this.options.canUseTool!(toolName, input, { signal: controller.signal, toolUseID, requestId: `req-${toolUseID}`, ...extra } as never);
  }
}

export interface FakeClaudeSdkOptions {
  onUser?: (query: FakeQuery, message: ClaudeUserInput) => void | Promise<void>;
  onString?: (query: FakeQuery, prompt: string) => void;
  onInterrupt?: (query: FakeQuery) => void | Promise<void>;
  /** Sessions Claude Code "has on disk". */
  sessions?: Set<string>;
}

export class FakeClaudeSdk implements ClaudeSdk {
  readonly queries: FakeQuery[] = [];
  readonly deleted: string[] = [];
  readonly servers: Array<{ name: string; tools: ClaudeMcpToolSpec[] }> = [];
  init: ClaudeInitResult = FAKE_INIT;

  constructor(readonly options: FakeClaudeSdkOptions = {}) {}

  async query(params: ClaudeQueryParams): Promise<ClaudeQuery> {
    const query = new FakeQuery(params, this);
    this.queries.push(query);
    return query;
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
    this.options.sessions?.delete(sessionId);
  }

  async hasSession(sessionId: string): Promise<boolean> {
    return this.options.sessions?.has(sessionId) ?? false;
  }

  async mcpServer(name: string, tools: ClaudeMcpToolSpec[]) {
    this.servers.push({ name, tools });
    return { type: "sdk" as const, name, instance: {} as never };
  }

  /** Chat queries (the ones with streaming input), not probes or one-shots. */
  get chats(): FakeQuery[] {
    return this.queries.filter((q) => typeof q.params.prompt !== "string" && q.options.persistSession !== false);
  }
}

export function stream(event: Record<string, unknown>, parent: string | null = null): ClaudeWire {
  return { type: "stream_event", event, parent_tool_use_id: parent, session_id: "s" };
}

export function assistant(id: string, content: Array<Record<string, unknown>>, usage?: Record<string, number>, extra: Record<string, unknown> = {}): ClaudeWire {
  return { type: "assistant", message: { id, role: "assistant", model: "claude-sonnet-5", content, ...(usage ? { usage } : {}) }, parent_tool_use_id: null, session_id: "s", ...extra };
}

export function toolResult(toolUseId: string, content: unknown, structured?: unknown, isError = false): ClaudeWire {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
    parent_tool_use_id: null,
    ...(structured !== undefined ? { tool_use_result: structured } : {}),
    session_id: "s",
  };
}

export function result(extra: { cost?: number; subtype?: string; isError?: boolean; text?: string; queued?: number; errors?: string[] } = {}): ClaudeWire {
  return {
    type: "result",
    subtype: extra.subtype ?? "success",
    is_error: extra.isError ?? false,
    result: extra.text ?? "",
    total_cost_usd: extra.cost ?? 0,
    modelUsage: { "claude-sonnet-5": { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, contextWindow: 200_000 } },
    ...(extra.queued !== undefined ? { queued_turn_count: extra.queued } : {}),
    ...(extra.errors ? { errors: extra.errors } : {}),
    session_id: "s",
  };
}
