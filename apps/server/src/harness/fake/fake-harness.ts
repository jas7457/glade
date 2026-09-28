import {
  AGENT_ENV,
  applyAgentEvent,
  clampThinkingLevel,
  defaultSessionState,
  emptyTranscript,
  type AgentEvent,
  type CompactResult,
  type HarnessCapabilities,
  type HarnessDefaults,
  type ModelInfo,
  type ModelRef,
  type PromptRequest,
  type SessionState,
  type ShellResult,
  type SlashCommand,
  type ThinkingLevel,
  type Transcript,
  type UiResponse,
} from "@glade/protocol";
import { compactionNoticeText } from "../format.js";
import { SessionEvents } from "../session-events.js";
import type { AgentHarness, GenerateTitleOptions, HarnessDescription, HarnessSession, OpenSessionOptions, ShellRunRequest } from "../types.js";

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

/** Tells this process's session refs apart from an earlier run's (the counter restarts). */
const RUN_ID = Date.now().toString(36);

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
    { type: "block_start", messageId: assistantId, index: 0, block: { type: "toolCall", id: toolCallId, name: "bash", kind: "shell", args: undefined } },
    { type: "block_delta", messageId: assistantId, index: 0, delta: '{"command":"echo hi"}', input: { command: "echo hi" } },
    { type: "block_end", messageId: assistantId, index: 0, block: { type: "toolCall", id: toolCallId, name: "bash", kind: "shell", input: { command: "echo hi" }, args: { command: "echo hi" } } },
    {
      type: "message_end",
      message: {
        id: assistantId,
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "bash", kind: "shell", input: { command: "echo hi" }, args: { command: "echo hi" } }],
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

/** What the fake harness can do: everything pi can except usage limits and sub-agents. */
export const FAKE_CAPABILITIES: HarnessCapabilities = {
  compact: true,
  exportHtml: true,
  steering: true,
  uiRequests: true,
  usageLimits: false,
  commands: true,
  subagents: false,
  shell: true,
};

export interface FakeHarnessOptions {
  /** Harness id (default "fake"); tests register several fakes with different ids (I-064). */
  id?: string;
  label?: string;
  /** Overrides of {@link FAKE_CAPABILITIES}. */
  capabilities?: Partial<HarnessCapabilities>;
}

/**
 * In-memory harness used by tests and `GLADE_HARNESS=fake` for UI development without an LLM.
 */
export class FakeHarness implements AgentHarness {
  readonly id: string;
  readonly info: HarnessDescription;
  readonly sessions = new Map<string, StoredSession>();
  readonly openSessions = new Set<FakeSession>();
  private counter = 0;

  constructor(
    public script: FakeScript = defaultFakeScript,
    /** Delay between emitted events (ms). 0 = synchronous after the prompt resolves. */
    public eventDelayMs = 0,
    options: FakeHarnessOptions = {},
  ) {
    this.id = options.id ?? "fake";
    this.info = { label: options.label ?? "Fake agent", capabilities: { ...FAKE_CAPABILITIES, ...options.capabilities } };
  }

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
      // Unique across restarts too: chats outlive the harness's memory (the store keeps them, I-121).
      ref = ref ?? `${this.id}-session-${++this.counter}-${RUN_ID}`;
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
    const session = new FakeSession(this, ref, options.cwd, options.env ?? {});
    this.openSessions.add(session);
    return session;
  }

  async deleteSession(sessionRef: string): Promise<void> {
    this.sessions.delete(sessionRef);
  }

  async readTranscript(sessionRef: string): Promise<Transcript | null> {
    return this.sessions.get(sessionRef)?.transcript ?? null;
  }

  async generateTitle({ firstMessage, excerpt }: GenerateTitleOptions): Promise<string | null> {
    // `/name` (I-074): name it after the latest text of the conversation excerpt.
    if (excerpt) return `Named: ${(excerpt.split("\n\n").at(-1) ?? "").replace(/^\w+: /, "").slice(0, 24)}`;
    return `Generated: ${firstMessage.slice(0, 20)}`;
  }

  async dispose(): Promise<void> {}
}

export class FakeSession implements HarnessSession {
  private readonly events = new SessionEvents();
  private state: SessionState;
  private idCounter = 0;
  readonly uiResponses: UiResponse[] = [];
  readonly prompts: PromptRequest[] = [];
  readonly compactions: Array<string | undefined> = [];
  /** Shell commands run (`!cmd` / `!!cmd`, I-076). */
  readonly shells: ShellRunRequest[] = [];
  /** Stops the running fake shell commands. */
  private readonly shellAborts = new Set<() => void>();

  constructor(
    private readonly harness: FakeHarness,
    readonly sessionRef: string,
    /** Folder the session was opened in. */
    readonly cwd = "",
    /** The agent API identity Glade gave the process (`GLADE_URL`, `GLADE_TOKEN`, …). */
    private readonly env: Record<string, string> = {},
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
    void this.play(events).then(() => this.agentCommand(request.text));
  }

  /**
   * Sub-agents without a model (UI work in `GLADE_HARNESS=fake` sandboxes): a prompt
   * `spawn <name> <task>` spawns a sub-agent through Glade's agent API, and a sub-agent whose
   * task starts with `report: <summary>` reports it with report_done, like pi's extension would.
   */
  private async agentCommand(text: string): Promise<void> {
    const url = this.env[AGENT_ENV.url];
    const token = this.env[AGENT_ENV.token];
    if (!url || !token) return;
    const spawn = /^spawn (\S+) ([\s\S]+)$/.exec(text.trim());
    const report = /^report: ([\s\S]+)$/.exec(text.trim());
    const call = (path: string, body: unknown) =>
      fetch(`${url}/api/agents/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          if (!res.ok) console.warn(`[fake] agent API ${path}: ${res.status} ${await res.text()}`);
        })
        .catch((err: Error) => console.warn(`[fake] agent API ${path}: ${err.message}`));
    if (spawn) await call("spawn", { name: spawn[1], task: spawn[2] });
    else if (report) await call("report-done", { summary: report[1] });
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
    this.events.emit(event);
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

  /**
   * Simulated shell (nothing is executed): `sleep N` waits N seconds (stoppable), `exit N` fails
   * with that code, anything else prints `fake output of: <command>` in two chunks.
   */
  async runShell(request: ShellRunRequest): Promise<ShellResult> {
    const { id, command, shareWithAgent } = request;
    this.shells.push(request);
    this.emit({ type: "shell_start", id, command, shared: shareWithAgent, at: Date.now() });
    let cancelled = false;
    let stop = () => {};
    const stopped = new Promise<void>((resolve) => {
      stop = () => {
        cancelled = true;
        resolve();
      };
    });
    this.shellAborts.add(stop);
    const wait = (ms: number) => Promise.race([new Promise((r) => setTimeout(r, ms)), stopped]);
    let output = "";
    let exitCode: number | null = 0;
    const sleep = /^sleep\s+(\d+(?:\.\d+)?)$/.exec(command.trim());
    const exit = /^exit\s+(\d+)$/.exec(command.trim());
    if (sleep) {
      await wait(Number(sleep[1]) * 1000);
    } else if (exit) {
      exitCode = Number(exit[1]);
    } else {
      for (const chunk of ["fake output of: ", `${command}\n`]) {
        await Promise.resolve();
        if (this.harness.eventDelayMs > 0) await wait(this.harness.eventDelayMs);
        if (cancelled) break;
        output += chunk;
        this.emit({ type: "shell_update", id, delta: chunk });
      }
    }
    this.shellAborts.delete(stop);
    const result: ShellResult = { output, exitCode: cancelled ? null : exitCode, cancelled, truncated: false };
    this.emit({ type: "shell_end", id, result, at: Date.now() });
    return result;
  }

  async abortShell(): Promise<void> {
    for (const stop of [...this.shellAborts]) stop();
  }

  async exportHtml(): Promise<string> {
    return `/tmp/glade-fake-export-${this.sessionRef}.html`;
  }

  respondToUi(response: UiResponse): void {
    this.uiResponses.push(response);
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    return this.events.onEvent(listener);
  }

  onExit(listener: (error: Error | null) => void): () => void {
    return this.events.onExit(listener);
  }

  /** Simulate a crash (tests). */
  crash(message = "boom"): void {
    this.events.exit(new Error(message));
  }

  async dispose(): Promise<void> {
    this.harness.openSessions.delete(this);
  }
}
