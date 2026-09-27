import {
  applyAgentEvent,
  clampThinkingLevel,
  defaultSessionState,
  emptyTranscript,
  type AgentEvent,
  type CompactResult,
  type HarnessDefaults,
  type ModelInfo,
  type ModelRef,
  type PromptRequest,
  type SessionState,
  type SlashCommand,
  type ThinkingLevel,
  type Transcript,
  type UiResponse,
} from "@pi-ui/protocol";
import { compactionNoticeText } from "../format.js";
import type { AgentHarness, GenerateTitleOptions, HarnessSession, OpenSessionOptions } from "../types.js";

export const FAKE_MODELS: ModelInfo[] = [
  {
    provider: "fake",
    id: "smart",
    name: "Fake Smart",
    thinkingLevels: ["off", "low", "medium", "high"],
    input: ["text", "image"],
    contextWindow: 200_000,
    imageLimits: { maxWidth: 2000, maxHeight: 2000, maxBytes: 1024 * 1024, jpegQuality: 80 },
  },
  { provider: "fake", id: "fast", name: "Fake Fast", thinkingLevels: ["off"], input: ["text"], contextWindow: 32_000 },
];

/** Commands the fake harness offers (one of each kind). */
export const FAKE_COMMANDS: SlashCommand[] = [
  { name: "fake-ext", description: "A fake extension command", source: "extension" },
  { name: "skill:fake-skill", description: "A fake skill", source: "skill" },
  { name: "fake-prompt", description: "A fake prompt template", source: "prompt" },
];

/** Pretend every prompt adds this many tokens of context (and costs a tenth of a cent). */
const FAKE_TOKENS_PER_PROMPT = 12_000;

/** Produces the events for one prompt. Default: echo the prompt back after a bash tool call. */
export type FakeScript = (request: PromptRequest, ids: () => string) => AgentEvent[];

export const defaultFakeScript: FakeScript = (request, nextId) => {
  const assistantId = nextId();
  const toolCallId = `call-${assistantId}`;
  const answerId = nextId();
  return [
    { type: "message_start", message: { id: assistantId, role: "assistant", content: [], timestamp: Date.now(), streaming: true } },
    { type: "block_start", messageId: assistantId, index: 0, block: { type: "toolCall", id: toolCallId, name: "bash", args: undefined } },
    { type: "block_end", messageId: assistantId, index: 0, block: { type: "toolCall", id: toolCallId, name: "bash", args: { command: "echo hi" } } },
    {
      type: "message_end",
      message: {
        id: assistantId,
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "bash", args: { command: "echo hi" } }],
        timestamp: Date.now(),
        stopReason: "toolUse",
      },
    },
    { type: "tool_start", toolCallId, toolName: "bash", args: { command: "echo hi" } },
    { type: "tool_end", toolCallId, result: { toolCallId, toolName: "bash", status: "done", output: "hi\n" } },
    { type: "message_start", message: { id: answerId, role: "assistant", content: [], timestamp: Date.now(), streaming: true } },
    { type: "block_start", messageId: answerId, index: 0, block: { type: "text", text: "" } },
    { type: "block_delta", messageId: answerId, index: 0, delta: "You said: " },
    { type: "block_delta", messageId: answerId, index: 0, delta: request.text },
    {
      type: "message_end",
      message: {
        id: answerId,
        role: "assistant",
        content: [{ type: "text", text: `You said: ${request.text}` }],
        timestamp: Date.now(),
        stopReason: "stop",
      },
    },
  ];
};

interface StoredSession {
  transcript: Transcript;
  /** Fake context size; `null` right after compaction (like pi). */
  contextTokens: number | null;
  totalTokens: number;
  cost: number;
  title: string | null;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel;
}

/**
 * In-memory harness used by tests and `PI_UI_HARNESS=fake` for UI development without an LLM.
 */
export class FakeHarness implements AgentHarness {
  readonly id = "fake";
  readonly sessions = new Map<string, StoredSession>();
  readonly openSessions = new Set<FakeSession>();
  private counter = 0;

  constructor(
    public script: FakeScript = defaultFakeScript,
    /** Delay between emitted events (ms). 0 = synchronous after the prompt resolves. */
    public eventDelayMs = 0,
  ) {}

  async listModels(): Promise<ModelInfo[]> {
    return FAKE_MODELS;
  }

  async getDefaults(): Promise<HarnessDefaults> {
    return { model: { provider: FAKE_MODELS[0]!.provider, id: FAKE_MODELS[0]!.id }, thinkingLevel: null };
  }

  async listFolderCommands(): Promise<SlashCommand[]> {
    return FAKE_COMMANDS;
  }

  async openSession(options: OpenSessionOptions): Promise<HarnessSession> {
    let ref = options.sessionRef;
    if (!ref || !this.sessions.has(ref)) {
      ref = ref ?? `fake-session-${++this.counter}`;
      this.sessions.set(ref, {
        transcript: emptyTranscript(),
        contextTokens: 0,
        totalTokens: 0,
        cost: 0,
        title: null,
        model: options.model ?? { provider: FAKE_MODELS[0]!.provider, id: FAKE_MODELS[0]!.id },
        thinkingLevel: options.thinkingLevel ?? "medium",
      });
    }
    const session = new FakeSession(this, ref, options.cwd);
    this.openSessions.add(session);
    return session;
  }

  async deleteSession(sessionRef: string): Promise<void> {
    this.sessions.delete(sessionRef);
  }

  async readTranscript(sessionRef: string): Promise<Transcript | null> {
    return this.sessions.get(sessionRef)?.transcript ?? null;
  }

  async generateTitle({ firstMessage }: GenerateTitleOptions): Promise<string | null> {
    return `Generated: ${firstMessage.slice(0, 20)}`;
  }

  async dispose(): Promise<void> {}
}

export class FakeSession implements HarnessSession {
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly exitListeners = new Set<(error: Error | null) => void>();
  private state: SessionState;
  private idCounter = 0;
  readonly uiResponses: UiResponse[] = [];
  readonly prompts: PromptRequest[] = [];
  readonly compactions: Array<string | undefined> = [];

  constructor(
    private readonly harness: FakeHarness,
    readonly sessionRef: string,
    /** Folder the session was opened in. */
    readonly cwd = "",
  ) {
    const stored = this.stored;
    const model = FAKE_MODELS.find((m) => m.provider === stored.model?.provider && m.id === stored.model?.id);
    this.state = {
      ...defaultSessionState(),
      model: stored.model,
      thinkingLevel: stored.thinkingLevel,
      thinkingLevels: model?.thinkingLevels ?? ["off"],
      ...this.statsState(),
    };
  }

  /** `contextUsage` + `sessionStats` derived from the stored counters. */
  private statsState(): Pick<SessionState, "contextUsage" | "sessionStats"> {
    const stored = this.stored;
    const info = FAKE_MODELS.find((m) => m.provider === stored.model?.provider && m.id === stored.model?.id);
    const contextWindow = info?.contextWindow ?? 200_000;
    const tokens = stored.contextTokens === null ? null : Math.min(stored.contextTokens, contextWindow);
    return {
      contextUsage: { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 },
      sessionStats: {
        tokens: { input: Math.round(stored.totalTokens * 0.8), output: Math.round(stored.totalTokens * 0.2), cacheRead: 0, cacheWrite: 0, total: stored.totalTokens },
        cost: stored.cost,
      },
    };
  }

  private get stored(): StoredSession {
    return this.harness.sessions.get(this.sessionRef)!;
  }

  getState(): SessionState {
    return this.state;
  }

  async loadTranscript(): Promise<Transcript> {
    return this.stored.transcript;
  }

  async prompt(request: PromptRequest): Promise<void> {
    this.prompts.push(request);
    const stored = this.stored;
    stored.contextTokens = (stored.contextTokens ?? 4_000) + FAKE_TOKENS_PER_PROMPT;
    stored.totalTokens += FAKE_TOKENS_PER_PROMPT;
    stored.cost += 0.001;
    const nextId = () => `${this.sessionRef}-${this.idCounter++}`;
    const events: AgentEvent[] = [
      { type: "run_start" },
      { type: "state", state: { isRunning: true } },
      {
        type: "message_start",
        message: { id: nextId(), role: "user", content: [{ type: "text", text: request.text }], timestamp: Date.now() },
      },
      ...this.harness.script(request, nextId),
      { type: "state", state: { isRunning: false, ...this.statsState() } },
      { type: "run_end" },
    ];
    void this.play(events);
  }

  private async play(events: AgentEvent[]): Promise<void> {
    await Promise.resolve();
    for (const event of events) {
      if (this.harness.eventDelayMs > 0) await new Promise((r) => setTimeout(r, this.harness.eventDelayMs));
      this.emit(event);
    }
  }

  /** Emit an arbitrary event (tests). */
  emit(event: AgentEvent): void {
    if (event.type === "state") this.state = { ...this.state, ...event.state };
    this.stored.transcript = applyAgentEvent(this.stored.transcript, event);
    for (const listener of this.listeners) listener(event);
  }

  async abort(): Promise<void> {
    this.emit({ type: "state", state: { isRunning: false } });
    this.emit({ type: "run_end" });
  }

  async setModel(model: ModelRef): Promise<void> {
    const info = FAKE_MODELS.find((m) => m.provider === model.provider && m.id === model.id);
    if (!info) throw new Error(`Unknown model ${model.provider}/${model.id}`);
    this.stored.model = model;
    const thinkingLevel = clampThinkingLevel(info.thinkingLevels, this.state.thinkingLevel);
    this.emit({ type: "state", state: { model, thinkingLevels: info.thinkingLevels, thinkingLevel, ...this.statsState() } });
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const clamped = clampThinkingLevel(this.state.thinkingLevels, level);
    this.stored.thinkingLevel = clamped;
    this.emit({ type: "state", state: { thinkingLevel: clamped } });
  }

  async setTitle(title: string): Promise<void> {
    this.stored.title = title;
  }

  async listCommands(): Promise<SlashCommand[]> {
    return FAKE_COMMANDS;
  }

  async compact(instructions?: string): Promise<CompactResult> {
    this.compactions.push(instructions);
    const stored = this.stored;
    const tokensBefore = stored.contextTokens ?? 0;
    const tokensAfter = Math.round(tokensBefore / 5);
    this.emit({ type: "state", state: { isCompacting: true } });
    if (this.harness.eventDelayMs > 0) await new Promise((r) => setTimeout(r, this.harness.eventDelayMs * 10));
    stored.contextTokens = null; // unknown until the next reply, like pi
    this.emit({ type: "state", state: { isCompacting: false, ...this.statsState() } });
    this.emit({
      type: "message_end",
      message: { id: `${this.sessionRef}-${this.idCounter++}`, role: "notice", kind: "compaction", text: compactionNoticeText(tokensBefore, tokensAfter), timestamp: Date.now() },
    });
    return { tokensBefore, tokensAfter };
  }

  async exportHtml(): Promise<string> {
    return `/tmp/pi-ui-fake-export-${this.sessionRef}.html`;
  }

  respondToUi(response: UiResponse): void {
    this.uiResponses.push(response);
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (error: Error | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Simulate a crash (tests). */
  crash(message = "boom"): void {
    for (const listener of this.exitListeners) listener(new Error(message));
  }

  async dispose(): Promise<void> {
    this.harness.openSessions.delete(this);
  }
}
