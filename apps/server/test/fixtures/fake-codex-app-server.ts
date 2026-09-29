/**
 * A scripted fake of `codex app-server` (I-177) for tests: an in-process {@link CodexTransport}
 * answering the JSON-RPC requests Glade sends (initialize, account, config, models, threads,
 * turns, limits), with no CLI and no model. A test's `onTurn` handler scripts each turn through a
 * {@link FakeTurn}: notifications (items, deltas, plan, usage), requests to Glade (approvals,
 * questions, tools) and the turn's end.
 *
 *   const codex = new FakeCodexAppServer({ onTurn: (t) => t.reply("Hello") });
 *   new CodexHarness({ connect: () => codex.connect(), … });
 */
import type { CodexModel, GetAccountRateLimitsResponse, GetAccountResponse, RequestId, RpcMessage, ThreadItem, TurnError } from "../../src/harness/codex/protocol.js";
import type { CodexTransport } from "../../src/harness/codex/rpc.js";

export const FAKE_MODELS: CodexModel[] = [
  {
    id: "gpt-6-luna",
    model: "gpt-6-luna",
    displayName: "GPT-6-Luna",
    description: "Fast and affordable model for easier tasks.",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    isDefault: true,
  },
  {
    id: "gpt-5.6-terra",
    model: "gpt-5.6-terra",
    displayName: "GPT-5.6-Terra",
    description: "Older balanced model for straightforward work.",
    hidden: false,
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    isDefault: false,
  },
  { id: "secret", model: "secret", displayName: "Hidden", description: "", hidden: true, supportedReasoningEfforts: [], defaultReasoningEffort: "medium", isDefault: false },
];

/** The real rate limits of a free account with its usage spent (captured 2026-09-29, resets 2026-10-13). */
export const LIMIT_REACHED: GetAccountRateLimitsResponse = {
  ordinaryUsageAllowed: false,
  rateLimits: {
    limitId: "codex",
    limitName: null,
    primary: { usedPercent: 100, windowDurationMins: 43200, resetsAt: 1791922639 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: null },
    planType: "free",
    rateLimitReachedType: "rate_limit_reached",
  },
  rateLimitsByLimitId: null,
};

/** The real error of a turn refused by the usage limit (captured 2026-09-29). */
export const USAGE_LIMIT_ERROR: TurnError = {
  message: "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Oct 13th, 2026 4:17 PM.",
  codexErrorInfo: "usageLimitExceeded",
  additionalDetails: null,
};

export interface FakeCodexOptions {
  onTurn?: (turn: FakeTurn) => void | Promise<void>;
  /** A steered message arrived (`turn/steer`). */
  onSteer?: (turn: FakeTurn, text: string) => void;
  account?: GetAccountResponse;
  config?: Record<string, unknown>;
  models?: CodexModel[];
  rateLimits?: GetAccountRateLimitsResponse;
  /** `turn/interrupt` ends the turn as interrupted (default true). */
  interruptEnds?: boolean;
}

export interface FakeThread {
  id: string;
  params: Record<string, unknown>;
  /** Codex saved it (a turn ran). */
  saved: boolean;
  turns: FakeTurn[];
}

let threadSeq = 0;

export class FakeCodexAppServer {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly threads = new Map<string, FakeThread>();
  readonly connections: FakeConnection[] = [];
  readonly deleted: string[] = [];

  constructor(readonly options: FakeCodexOptions = {}) {}

  connect(): CodexTransport {
    const connection = new FakeConnection(this);
    this.connections.push(connection);
    return connection;
  }

  get live(): FakeConnection {
    return this.connections.at(-1)!;
  }

  /** Requests of one method. */
  sent(method: string): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  /** A saved thread Codex knows (as if from an earlier run). */
  addThread(id: string): FakeThread {
    const thread: FakeThread = { id, params: {}, saved: true, turns: [] };
    this.threads.set(id, thread);
    return thread;
  }

  lastTurn(): FakeTurn {
    const turns = [...this.threads.values()].flatMap((t) => t.turns);
    return turns.at(-1)!;
  }

  async handle(conn: FakeConnection, method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    const o = this.options;
    switch (method) {
      case "initialize":
        return { userAgent: "fake/0.159.1", codexHome: "/tmp/.codex", platformFamily: "unix", platformOs: "macos" };
      case "account/read":
        return o.account ?? { account: { type: "chatgpt", email: "me@example.com", planType: "plus" }, requiresOpenaiAuth: true };
      case "config/read":
        return { config: o.config ?? { model: null, model_reasoning_effort: null, approval_policy: null, sandbox_mode: null } };
      case "model/list":
        return { data: o.models ?? FAKE_MODELS, nextCursor: null };
      case "account/rateLimits/read":
        return o.rateLimits ?? { ordinaryUsageAllowed: true, rateLimits: { limitId: "codex", limitName: null, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791922639 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1792000000 }, credits: null, planType: "plus", rateLimitReachedType: null }, rateLimitsByLimitId: null };
      case "thread/start": {
        const id = `thr-${++threadSeq}`;
        this.threads.set(id, { id, params, saved: false, turns: [] });
        conn.loaded.add(id);
        return { thread: { id }, model: (params.model as string) ?? "gpt-6-luna", reasoningEffort: (o.config?.model_reasoning_effort as string) ?? "medium", approvalPolicy: params.approvalPolicy, sandbox: { type: "readOnly", networkAccess: false } };
      }
      case "thread/resume": {
        const thread = this.threads.get(params.threadId as string);
        if (!thread || !thread.saved) throw rpcError(-32600, `no rollout found for thread id ${params.threadId}`);
        conn.loaded.add(thread.id);
        return { thread: { id: thread.id }, model: (params.model as string) ?? "gpt-6-luna", reasoningEffort: "medium", approvalPolicy: params.approvalPolicy, sandbox: { type: "readOnly", networkAccess: false } };
      }
      case "turn/start": {
        const thread = this.threads.get(params.threadId as string);
        if (!thread || !conn.loaded.has(thread.id)) throw rpcError(-32600, `thread not found: ${params.threadId}`);
        thread.saved = true;
        const turn = new FakeTurn(this, conn, thread, params);
        thread.turns.push(turn);
        setImmediate(() => {
          turn.notify("turn/started", { threadId: thread.id, turn: { id: turn.id, status: "inProgress", error: null } });
          void o.onTurn?.(turn);
        });
        return { turn: { id: turn.id, status: "inProgress", error: null, items: [] } };
      }
      case "turn/steer": {
        const turn = this.lastTurn();
        if (!turn || turn.done || turn.id !== params.expectedTurnId) throw rpcError(-32600, "no active turn to steer");
        const input = params.input as Array<{ type: string; text?: string }>;
        turn.steered.push(input.map((i) => i.text ?? "").join(""));
        o.onSteer?.(turn, turn.steered.at(-1)!);
        return { turnId: turn.id };
      }
      case "turn/interrupt": {
        const turn = this.lastTurn();
        if (turn && !turn.done && o.interruptEnds !== false) setImmediate(() => turn.complete("interrupted"));
        return {};
      }
      case "thread/compact/start": {
        const thread = this.threads.get(params.threadId as string)!;
        const turn = new FakeTurn(this, conn, thread, params);
        thread.turns.push(turn);
        setImmediate(() => {
          turn.notify("turn/started", { threadId: thread.id, turn: { id: turn.id, status: "inProgress", error: null } });
          turn.item({ type: "contextCompaction", id: "cc1" });
          turn.usage(1200, 272000);
          turn.complete();
        });
        return {};
      }
      case "thread/delete":
        this.deleted.push(params.threadId as string);
        this.threads.delete(params.threadId as string);
        return {};
      case "thread/unsubscribe":
        return { status: "unsubscribed" };
      default:
        throw rpcError(-32601, `unknown method ${method}`);
    }
  }
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

export class FakeConnection implements CodexTransport {
  private readonly listeners: Array<(m: RpcMessage) => void> = [];
  private readonly closers: Array<(e: Error | null) => void> = [];
  private readonly waiting = new Map<RequestId, (m: RpcMessage) => void>();
  private nextId = 1000;
  closed = false;
  readonly loaded = new Set<string>();

  constructor(private readonly server: FakeCodexAppServer) {}

  send(message: RpcMessage): void {
    if (this.closed) return;
    if (message.method !== undefined) {
      const { id, method } = message;
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (id === undefined) return; // notification (initialized)
      void Promise.resolve()
        .then(() => this.server.handle(this, method, params))
        .then(
          (result) => this.deliver({ id, result }),
          (err: Error & { code?: number }) => this.deliver({ id, error: { code: err.code ?? -32603, message: err.message } }),
        );
      return;
    }
    if (message.id !== undefined) {
      const waiter = this.waiting.get(message.id);
      this.waiting.delete(message.id);
      waiter?.(message);
    }
  }

  onMessage(listener: (m: RpcMessage) => void): void {
    this.listeners.push(listener);
  }

  onClose(listener: (e: Error | null) => void): void {
    this.closers.push(listener);
  }

  close(): void {
    this.crash(null);
  }

  /** The process ends (`error`: a crash). */
  crash(error: Error | null = new Error("codex app-server exited (code 1)")): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.closers) c(error);
  }

  deliver(message: RpcMessage): void {
    if (this.closed) return;
    setImmediate(() => {
      if (!this.closed) for (const l of this.listeners) l(message);
    });
  }

  /** A request to Glade; resolves with its reply. */
  request(method: string, params: Record<string, unknown>): Promise<RpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.deliver({ id, method, params });
    });
  }
}

let turnSeq = 0;
let itemSeq = 0;

export class FakeTurn {
  readonly id = `turn-${++turnSeq}`;
  done = false;
  readonly steered: string[] = [];

  constructor(
    readonly server: FakeCodexAppServer,
    readonly conn: FakeConnection,
    readonly thread: FakeThread,
    readonly params: Record<string, unknown>,
  ) {}

  /** The prompt text sent with `turn/start`. */
  get text(): string {
    return ((this.params.input as Array<{ type: string; text?: string }>) ?? []).map((i) => i.text ?? "").join("");
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.conn.deliver({ method, params });
  }

  private base() {
    return { threadId: this.thread.id, turnId: this.id };
  }

  started(item: ThreadItem): void {
    this.notify("item/started", { ...this.base(), item, startedAtMs: 0 });
  }

  completed(item: ThreadItem): void {
    this.notify("item/completed", { ...this.base(), item, completedAtMs: 0 });
  }

  /** An item that starts and completes at once. */
  item(item: ThreadItem): void {
    this.started(item);
    this.completed(item);
  }

  delta(method: string, itemId: string, delta: string, extra: Record<string, unknown> = {}): void {
    this.notify(method, { ...this.base(), itemId, delta, ...extra });
  }

  /** A streamed agent message (two deltas, then the completed item). */
  message(text: string): string {
    const id = `msg-${++itemSeq}`;
    this.started({ type: "agentMessage", id, text: "" });
    const half = Math.ceil(text.length / 2);
    this.delta("item/agentMessage/delta", id, text.slice(0, half));
    this.delta("item/agentMessage/delta", id, text.slice(half));
    this.completed({ type: "agentMessage", id, text });
    return id;
  }

  /** A whole reply: the message and the turn's end. */
  reply(text: string): void {
    this.message(text);
    this.usage(5000, 272000);
    this.complete();
  }

  usage(lastTotal: number, window: number | null): void {
    const b = (n: number) => ({ totalTokens: n, inputTokens: n - 100, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 20 });
    this.notify("thread/tokenUsage/updated", { ...this.base(), tokenUsage: { total: b(lastTotal * 2), last: b(lastTotal), modelContextWindow: window } });
  }

  plan(steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>, explanation: string | null = null): void {
    this.notify("turn/plan/updated", { ...this.base(), plan: steps, explanation });
  }

  /** A request to Glade about this turn (approvals, questions, tools); resolves with the result. */
  async ask<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    const reply = await this.conn.request(method, { ...this.base(), ...params });
    if (reply.error) throw new Error(reply.error.message);
    return reply.result as T;
  }

  complete(status: "completed" | "interrupted" | "failed" = "completed", error: TurnError | null = null): void {
    if (this.done) return;
    this.done = true;
    this.notify("turn/completed", { threadId: this.thread.id, turn: { id: this.id, status, error, items: [] } });
  }

  /** Fail like Codex does: an `error` notification, the failed turn, then the thread unloaded. */
  fail(error: TurnError): void {
    this.notify("error", { ...this.base(), error, willRetry: false });
    this.complete("failed", error);
    this.conn.loaded.delete(this.thread.id);
    this.notify("thread/status/changed", { threadId: this.thread.id, status: { type: "notLoaded" } });
  }
}
