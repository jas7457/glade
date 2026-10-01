import {
  AGENT_ENV,
  applyAgentEvent,
  clampThinkingLevel,
  defaultSessionState,
  emptyTranscript,
  type AgentEvent,
  type CompactResult,
  type FolderPermissionModes,
  type HarnessCapabilities,
  type HarnessDefaults,
  type ModelInfo,
  type ModelRef,
  type PermissionModeInfo,
  type PromptRequest,
  type SessionState,
  type ShellResult,
  type SlashCommand,
  type ThinkingLevel,
  type Transcript,
  type UiRequest,
  type UiResponse,
} from "@glade/protocol";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactionNoticeText } from "../format.js";
import { fakePng } from "./fake-image.js";
import { SessionEvents } from "../session-events.js";
import type {
  AgentHarness,
  GenerateTitleOptions,
  HarnessDescription,
  HarnessSession,
  NativeSubagentEvent,
  OpenSessionOptions,
  ShellRunRequest,
  SideQuestionCall,
  SideQuestionResult,
} from "../types.js";

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
  // `stream <n>`: a long reply of n words, one delta each (testing live sync, I-122).
  const stream = /^stream (\d+)$/.exec(request.text.trim());
  if (stream) {
    const id = nextId();
    const words = Array.from({ length: Math.min(Number(stream[1]), 5000) }, (_, i) => `word${i + 1}${(i + 1) % 12 === 0 ? "\n\n" : " "}`);
    return [
      { type: "message_start", message: { id, role: "assistant", content: [], timestamp: Date.now(), streaming: true } },
      { type: "block_start", messageId: id, index: 0, block: { type: "text", text: "" } },
      ...words.map((delta) => ({ type: "block_delta" as const, messageId: id, index: 0, delta })),
      { type: "message_end", message: { id, role: "assistant", content: [{ type: "text", text: words.join("") }], timestamp: Date.now(), stopReason: "stop" } },
    ];
  }
  // `screenshot`: a tool call whose result is an image (I-157).
  if (request.text.trim() === "screenshot") {
    const id = nextId();
    const toolCallId = `call-${id}`;
    const answer = nextId();
    const call = { type: "toolCall" as const, id: toolCallId, name: "screenshot", kind: "other" as const, args: {} };
    const data = fakePng(Number.parseInt(id.replace(/\D/g, "") || "0", 10)).toString("base64");
    return [
      { type: "message_start", message: { id, role: "assistant", content: [call], timestamp: Date.now(), streaming: true } },
      { type: "message_end", message: { id, role: "assistant", content: [call], timestamp: Date.now(), stopReason: "toolUse" } },
      { type: "tool_start", toolCallId, toolName: "screenshot", args: {} },
      { type: "tool_end", toolCallId, result: { toolCallId, toolName: "screenshot", status: "done", output: "Took a screenshot", images: [{ type: "image", mimeType: "image/png", data }] } },
      { type: "message_start", message: { id: answer, role: "assistant", content: [{ type: "text", text: "Here it is." }], timestamp: Date.now(), streaming: true } },
      { type: "message_end", message: { id: answer, role: "assistant", content: [{ type: "text", text: "Here it is." }], timestamp: Date.now(), stopReason: "stop" } },
    ];
  }
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
  /** With {@link FakeHarnessOptions.permissionModes}: the session's mode. */
  permissionMode: string | null;
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
  sideQuestions: true,
};

/** The fake harness's side answer (I-140): canned, streamed word by word. */
export function fakeSideAnswer(question: string): string {
  return `Side answer to "${question}": the agent keeps working meanwhile. This reply is canned by the fake harness, streamed word by word, and **never** reaches the agent's context.`;
}

export interface FakeHarnessOptions {
  /** Harness id (default "fake"); tests register several fakes with different ids (I-064). */
  id?: string;
  label?: string;
  /** Overrides of {@link FAKE_CAPABILITIES}. */
  capabilities?: Partial<HarnessCapabilities>;
  /**
   * Permission modes (I-174/I-184; tests): turns on the `permissionModes` capability; sessions
   * start in `OpenSessionOptions.permissionMode` when it's one of these, else `defaultPermissionMode`.
   */
  permissionModes?: PermissionModeInfo[];
  /** Default: the first of `permissionModes`. */
  defaultPermissionMode?: string;
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
  /** How long a `spawn` prompt's spawn_agent call runs before the agent is started (ms, I-145). */
  spawnDelayMs = 2000;
  /** Side questions asked (I-140), for tests. */
  readonly sideQuestions: SideQuestionCall[] = [];
  /** Delay between the side answer's words (ms; default: the event delay). */
  sideAnswerDelayMs: number | null = null;
  /** Make the next side questions fail with this error (tests). */
  sideAnswerError: string | null = null;

  constructor(
    public script: FakeScript = defaultFakeScript,
    /** Delay between emitted events (ms). 0 = synchronous after the prompt resolves. */
    public eventDelayMs = 0,
    options: FakeHarnessOptions = {},
  ) {
    this.id = options.id ?? "fake";
    this.permissionModes = options.permissionModes ?? [];
    this.defaultPermissionMode = options.defaultPermissionMode ?? this.permissionModes[0]?.id ?? null;
    const modes = this.permissionModes.length ? { permissionModes: true } : {};
    this.info = { label: options.label ?? "Fake agent", capabilities: { ...FAKE_CAPABILITIES, ...modes, ...options.capabilities } };
  }

  /** See {@link FakeHarnessOptions.permissionModes}. */
  readonly permissionModes: PermissionModeInfo[];
  readonly defaultPermissionMode: string | null;
  /** Folders/models `getPermissionModes` was asked for (tests). */
  readonly permissionModeQueries: Array<{ cwd: string; model: ModelRef | null }> = [];

  async getPermissionModes(cwd: string, model: ModelRef | null): Promise<FolderPermissionModes> {
    this.permissionModeQueries.push({ cwd, model });
    return { modes: this.permissionModes, defaultMode: this.defaultPermissionMode };
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
        permissionMode: this.permissionModes.some((m) => m.id === options.permissionMode) ? options.permissionMode! : this.defaultPermissionMode,
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

  /** A canned answer, streamed word by word (I-140). */
  async answerSideQuestion(call: SideQuestionCall): Promise<SideQuestionResult> {
    this.sideQuestions.push(call);
    const question = /(?:Side|Follow-up side) question: ([\s\S]*)$/.exec(call.prompt)?.[1]?.trim() ?? "";
    if (this.sideAnswerError) return { answer: "", error: this.sideAnswerError };
    const words = fakeSideAnswer(question).split(/(?<= )/);
    const delay = this.sideAnswerDelayMs ?? this.eventDelayMs;
    let answer = "";
    for (const word of words) {
      await new Promise((r) => (delay > 0 ? setTimeout(r, delay) : setImmediate(r)));
      if (call.signal.aborted) return { answer };
      answer += word;
      call.onDelta(word);
    }
    return { answer };
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
      ...(harness.permissionModes.length ? { permissionMode: stored.permissionMode, permissionModes: harness.permissionModes } : {}),
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
    const native = /^native(?: (\d))? ([\s\S]+)$/.exec(request.text.trim());
    if (native) {
      this.emit({ type: "message_end", message: { id: `${this.sessionRef}-${this.idCounter++}`, role: "user", content: [{ type: "text", text: request.text }], timestamp: Date.now() } });
      void this.nativeCall(Math.max(1, Number(native[1] ?? 1)), native[2]!.trim());
      return;
    }
    const ask = /^ask (select|confirm|input) ([\s\S]+)$/.exec(request.text.trim());
    if (ask) {
      void this.askCall(request.text, ask[1] as "select" | "confirm" | "input", ask[2]!.trim());
      return;
    }
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
        message: {
          id: nextId(),
          role: "user",
          // Attached images show in the transcript like with pi (UI checks, I-131).
          content: [...(request.images ?? []).map((i) => ({ type: "image" as const, mimeType: i.mimeType, data: i.data })), { type: "text", text: request.text }],
          timestamp: Date.now(),
        },
      },
      ...this.harness.script(request, nextId),
      { type: "state", state: { isRunning: false, ...this.statsState() } },
      { type: "run_end" },
    ];
    void this.play(events).then(() => this.agentCommand(request.text));
  }

  /** Answers awaited by `ask …` prompts, by request id. */
  private readonly asked = new Map<string, (response: UiResponse) => void>();

  /**
   * A question from the agent without a model (I-193; tests and `GLADE_HARNESS=fake` sandboxes):
   * `ask select Which database? | PostgreSQL | SQLite`, `ask confirm Delete it?`, `ask input Name
   * the branch`. The run waits for the answer and replies with it ("You picked: SQLite").
   */
  private async askCall(text: string, kind: "select" | "confirm" | "input", rest: string): Promise<void> {
    const nextId = () => `${this.sessionRef}-${this.idCounter++}`;
    const [title, ...options] = rest.split("|").map((p) => p.trim());
    const id = `ask-${nextId()}`;
    const ui: UiRequest =
      kind === "select" ? { id, kind, title: title!, options } : kind === "confirm" ? { id, kind, title: title!, message: options[0] } : { id, kind, title: title! };
    await this.play([
      { type: "run_start" },
      { type: "state", state: { isRunning: true } },
      { type: "message_start", message: { id: nextId(), role: "user", content: [{ type: "text", text }], timestamp: Date.now() } },
      { type: "ui_request", request: ui },
    ]);
    const response = await new Promise<UiResponse>((resolve) => this.asked.set(id, resolve));
    const answer = "cancelled" in response ? "You didn't answer." : "confirmed" in response ? (response.confirmed ? "You said yes." : "You said no.") : `You picked: ${response.value}`;
    const replyId = nextId();
    const message = { id: replyId, role: "assistant" as const, content: [{ type: "text" as const, text: answer }], timestamp: Date.now() };
    await this.play([
      { type: "message_start", message: { ...message, streaming: true } },
      { type: "message_end", message: { ...message, stopReason: "stop" } },
      { type: "state", state: { isRunning: false, ...this.statsState() } },
      { type: "run_end" },
    ]);
  }

  /** Native sub-agents still running (`native …` prompts, I-188): stopped with the session. */
  private readonly natives = new Set<string>();
  /** How long a fake native sub-agent works (ms; tests lower it). */
  nativeStepMs = 700;

  /**
   * The harness's own sub-agents without a model (I-188; tests and `GLADE_HARNESS=fake`
   * sandboxes): `native <task>` / `native <n> <task>` runs n sub-agents of the fake's own (like
   * Claude Code's Task tool): a task call in the chat, and each sub-agent streams a reply and a
   * command in its own tab, then reports.
   */
  private async nativeCall(count: number, task: string): Promise<void> {
    const id = `${this.sessionRef}-${this.idCounter++}`;
    const step = () => new Promise((r) => setTimeout(r, this.nativeStepMs));
    const calls = Array.from({ length: count }, (_, i) => ({ toolCallId: `task-${id}-${i}`, agent: `native-${id}-${i}` }));
    const blocks = calls.map(({ toolCallId }, i) => ({
      type: "toolCall" as const,
      id: toolCallId,
      name: "Task",
      kind: "task" as const,
      input: { description: count > 1 ? `${task} (${i + 1})` : task },
      args: { description: task, prompt: task },
    }));
    this.emit({ type: "run_start" });
    this.emit({ type: "state", state: { isRunning: true } });
    this.emit({ type: "message_end", message: { id, role: "assistant", content: blocks, timestamp: Date.now(), stopReason: "toolUse" } });
    await Promise.all(
      calls.map(async ({ toolCallId, agent }, i) => {
        this.emit({ type: "tool_start", toolCallId, toolName: "Task", args: { prompt: task } });
        this.natives.add(agent);
        this.events.native({ type: "native_subagent_start", id: agent, toolCallId, name: "general-purpose", title: blocks[i]!.input.description, task });
        const sub = (event: AgentEvent) => this.natives.has(agent) && this.events.native({ type: "native_subagent_event", id: agent, event });
        const m1 = `${agent}-a`;
        const bash = `${agent}-bash`;
        const call = { type: "toolCall" as const, id: bash, name: "Bash", kind: "shell" as const, input: { command: "ls src | wc -l" }, args: { command: "ls src | wc -l" } };
        await step();
        sub({ type: "message_start", message: { id: m1, role: "assistant", content: [], timestamp: Date.now(), streaming: true } });
        sub({ type: "block_start", messageId: m1, index: 0, block: { type: "thinking", text: "" } });
        sub({ type: "block_delta", messageId: m1, index: 0, delta: "Counting the files." });
        sub({ type: "block_start", messageId: m1, index: 1, block: call });
        sub({ type: "message_end", message: { id: m1, role: "assistant", content: [{ type: "thinking", text: "Counting the files." }, call], timestamp: Date.now(), stopReason: "toolUse" } });
        sub({ type: "tool_start", toolCallId: bash, toolName: "Bash", args: call.args });
        await step();
        sub({ type: "tool_end", toolCallId: bash, result: { toolCallId: bash, toolName: "Bash", status: "done", output: `${3 + i}\n` } });
        const m2 = `${agent}-b`;
        const report = `There are ${3 + i} files in src.`;
        sub({ type: "message_start", message: { id: m2, role: "assistant", content: [], timestamp: Date.now(), streaming: true } });
        sub({ type: "block_start", messageId: m2, index: 0, block: { type: "text", text: "" } });
        sub({ type: "block_delta", messageId: m2, index: 0, delta: report });
        await step();
        if (!this.natives.delete(agent)) return; // stopped meanwhile
        this.events.native({ type: "native_subagent_event", id: agent, event: { type: "message_end", message: { id: m2, role: "assistant", content: [{ type: "text", text: report }], timestamp: Date.now(), stopReason: "stop" } } });
        this.events.native({ type: "native_subagent_end", id: agent, status: "done", result: report });
        this.emit({ type: "tool_end", toolCallId, result: { toolCallId, toolName: "Task", status: "done", output: report } });
      }),
    );
    if (!this.state.isRunning) return; // stopped
    const answer = `${this.sessionRef}-${this.idCounter++}`;
    this.emit({ type: "message_end", message: { id: answer, role: "assistant", content: [{ type: "text", text: "The sub-agents are done." }], timestamp: Date.now(), stopReason: "stop" } });
    this.emit({ type: "state", state: { isRunning: false } });
    this.emit({ type: "run_end" });
  }

  /** Emit a native sub-agent event (tests). */
  emitNative(event: NativeSubagentEvent): void {
    this.events.native(event);
  }

  onNativeSubagent(listener: (event: NativeSubagentEvent) => void): () => void {
    return this.events.onNativeSubagent(listener);
  }

  async stopNativeSubagent(id: string): Promise<void> {
    if (this.natives.delete(id)) this.events.native({ type: "native_subagent_end", id, status: "stopped" });
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
    if (spawn) await this.spawnCall(spawn[1]!, spawn[2]!, () => call("spawn", { name: spawn[1], task: spawn[2] }));
    else if (report) await call("report-done", { summary: report[1] });
  }

  /**
   * The parent's side of `spawn`: a `spawn_agent` tool call around the API call, slowed down by
   * `spawnDelayMs` so the "Starting an agent…" card can be seen (I-145).
   */
  private async spawnCall(name: string, task: string, spawn: () => Promise<void>): Promise<void> {
    const id = `${this.sessionRef}-${this.idCounter++}`;
    const toolCallId = `call-${id}`;
    const args = { name, task };
    const block = { type: "toolCall" as const, id: toolCallId, name: "spawn_agent", kind: "task" as const, input: { agentName: name, description: task.split("\n")[0] }, args };
    this.emit({ type: "run_start" });
    this.emit({ type: "state", state: { isRunning: true } });
    this.emit({ type: "message_end", message: { id, role: "assistant", content: [block], timestamp: Date.now(), stopReason: "toolUse" } });
    this.emit({ type: "tool_start", toolCallId, toolName: "spawn_agent", args });
    if (this.harness.spawnDelayMs > 0) await new Promise((r) => setTimeout(r, this.harness.spawnDelayMs));
    await spawn();
    this.emit({ type: "tool_end", toolCallId, result: { toolCallId, toolName: "spawn_agent", status: "done", output: `Spawned ${name}.` } });
    this.emit({ type: "state", state: { isRunning: false } });
    this.emit({ type: "run_end" });
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
    this.asked.clear();
    for (const agent of this.natives) this.events.native({ type: "native_subagent_end", id: agent, status: "stopped" });
    this.natives.clear();
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

  async setPermissionMode(mode: string): Promise<void> {
    if (!this.harness.permissionModes.some((m) => m.id === mode)) throw new Error(`Unknown mode ${mode}`);
    this.stored.permissionMode = mode;
    this.emit({ type: "state", state: { permissionMode: mode } });
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
    const path = join(tmpdir(), `glade-fake-export-${this.sessionRef}.html`);
    // A real file, so downloads work in sandboxes (I-123).
    await writeFile(path, `<!doctype html><title>Fake export</title><p>${this.sessionRef}</p>`);
    return path;
  }

  respondToUi(response: UiResponse): void {
    this.uiResponses.push(response);
    const answer = this.asked.get(response.id);
    this.asked.delete(response.id);
    answer?.(response);
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
