/**
 * One Glade chat with an ACP agent (I-119). The agent process starts lazily with the first prompt
 * (viewing a chat never starts it), then:
 *
 *   initialize (fs read/write; no terminal) → session/load (agent supports `loadSession`) or
 *   session/resume (`sessionCapabilities.resume`) of the saved ACP session id, else session/new
 *   → session/prompt per turn, session/cancel to stop.
 *
 * `session/update`s of a running turn become `AgentEvent`s (`translate.ts`); updates outside a
 * turn (the history an agent replays on `session/load`) only refresh metadata (commands, mode,
 * usage), because Glade keeps its own copy of the transcript (the store, I-121); only the ACP
 * session id and title are saved here (`resume-store.ts`). Permission requests become
 * `permission` dialogs answered with `respondToUi`; file reads/writes are confined to the chat's folder (`fs.ts`).
 * Messages sent while a turn runs are queued as follow-ups (ACP has no steering); like pi, they're
 * sent after a run that finishes, and stay queued when it's stopped or fails.
 */
import { RequestError, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  AvailableCommand,
  ContentBlock as AcpContentBlock,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import {
  applyAgentEvent,
  defaultSessionState,
  emptyTranscript,
  type AcpAgentConfig,
  type AgentEvent,
  type ModelRef,
  type PromptRequest,
  type SessionState,
  type SlashCommand,
  type ThinkingLevel,
  type Transcript,
  type UiRequest,
  type UiResponse,
} from "@glade/protocol";
import { piChildEnv } from "../pi/child-env.js";
import { SessionEvents } from "../session-events.js";
import type { HarnessSession } from "../types.js";
import { AcpProcess, type AcpClientHandlers } from "./connection.js";
import { FsAccessError, readTextFile, writeTextFile } from "./fs.js";
import { acpToolSummary } from "./tools.js";
import { AcpTranslator, type TurnEnd } from "./translate.js";
import type { AcpResumeState, AcpResumeStore } from "./resume-store.js";

/** JSON-RPC error code ACP agents use for "authentication required". */
const AUTH_REQUIRED = -32000;

export interface AcpSessionOptions {
  harnessId: string;
  config: AcpAgentConfig;
  cwd: string;
  sessionRef: string;
  /** Saved resume state (`null` for a new chat). */
  resume: AcpResumeState | null;
  store: AcpResumeStore;
  /** How long to wait for the agent to confirm a `session/cancel` before ending the run anyway. */
  cancelGraceMs?: number;
  /** Starts the agent process (tests may inject; default spawns `config.command`). */
  startProcess?: (handlers: AcpClientHandlers) => AcpProcess;
  clientVersion?: string;
  log?: (msg: string) => void;
}

interface Connected {
  process: AcpProcess;
  sessionId: string;
  capabilities: AgentCapabilities;
}

interface Turn {
  aborted: boolean;
  done: boolean;
  /** `session/prompt` was sent (a cancel must go to the agent). */
  prompted: boolean;
}

interface PendingPermission {
  request: UiRequest & { kind: "permission" };
  resolve: (response: RequestPermissionResponse) => void;
}

export class AcpSession implements HarnessSession {
  readonly sessionRef: string;
  private readonly events: SessionEvents;
  private state: SessionState;
  private transcript: Transcript;
  private file: AcpResumeState;
  private connected: Connected | null = null;
  private connecting: Promise<Connected> | null = null;
  private readonly translator: AcpTranslator;
  private turn: Turn | null = null;
  private readonly queue: PromptRequest[] = [];
  private readonly permissions = new Map<string, PendingPermission>();
  private permissionSeq = 0;
  private commands: SlashCommand[] = [];
  private modeId: string | null = null;
  private disposed = false;
  private cancelTimer: NodeJS.Timeout | null = null;
  /** Token totals reported by `session/prompt` responses. */
  private totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  private cost = 0;

  constructor(private readonly options: AcpSessionOptions) {
    this.sessionRef = options.sessionRef;
    this.file = options.resume ?? { acpSessionId: null, title: null };
    this.transcript = emptyTranscript();
    this.events = new SessionEvents(options.log);
    this.state = { ...defaultSessionState() };
    this.translator = new AcpTranslator(`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`);
  }

  private get label(): string {
    return this.options.config.name;
  }

  // HarnessSession ------------------------------------------------------------------------------

  getState(): SessionState {
    return this.state;
  }

  async loadTranscript(): Promise<Transcript> {
    return this.transcript;
  }

  async prompt(request: PromptRequest): Promise<void> {
    if (this.disposed) throw new Error("The session is closed");
    if (this.turn) {
      // ACP can't steer a running turn: queue it and send it when the turn ends.
      this.queue.push(request);
      this.emitQueue();
      return;
    }
    void this.runTurn(request);
  }

  async abort(): Promise<void> {
    // Queued follow-ups stay queued (like pi): they're sent after the next run that finishes.
    const turn = this.turn;
    if (!turn || turn.done) return;
    turn.aborted = true;
    // The spec: after session/cancel the client answers pending permission requests "cancelled".
    this.cancelPermissions();
    const connected = this.connected;
    if (turn.prompted && connected) {
      void connected.process.connection.agent.notify("session/cancel", { sessionId: connected.sessionId }).catch(() => {});
      // The agent should answer the prompt with `cancelled`; don't wait forever if it doesn't.
      this.cancelTimer = setTimeout(() => this.finishTurn(turn, { stopReason: "cancelled" }), this.options.cancelGraceMs ?? 10_000);
      this.cancelTimer.unref();
    }
    // Not prompted yet (still starting the agent): `runTurn` stops before sending the prompt.
  }

  async setModel(_model: ModelRef): Promise<void> {
    throw new Error(`${this.label} chooses its own model`);
  }

  async setThinkingLevel(_level: ThinkingLevel): Promise<void> {
    throw new Error(`${this.label} doesn't have thinking levels`);
  }

  async setTitle(title: string): Promise<void> {
    if (this.file.title === title) return;
    this.file = { ...this.file, title };
    this.persist();
  }

  respondToUi(response: UiResponse): void {
    const pending = this.permissions.get(response.id);
    if (!pending) return;
    this.permissions.delete(response.id);
    const option = "value" in response ? pending.request.options.find((o) => o.id === response.value) : undefined;
    if (option) {
      if (pending.request.toolCallId && option.kind.startsWith("reject")) this.translator.rejectTool(pending.request.toolCallId);
      pending.resolve({ outcome: { outcome: "selected", optionId: option.id } });
    } else {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  /** Commands the agent reported (`available_commands_update`); empty until it has started. */
  async listCommands(): Promise<SlashCommand[]> {
    return this.commands;
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    return this.events.onEvent(listener);
  }

  onExit(listener: (error: Error | null) => void): () => void {
    return this.events.onExit(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelPermissions();
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    const connected = this.connected;
    this.connected = null;
    if (connected) {
      if (this.turn?.prompted) await connected.process.connection.agent.notify("session/cancel", { sessionId: connected.sessionId }).catch(() => {});
      await connected.process.kill();
    }
  }

  /** The current ACP mode id (`current_mode_update`), for diagnostics. */
  get mode(): string | null {
    return this.modeId;
  }

  // Turns ---------------------------------------------------------------------------------------

  private async runTurn(request: PromptRequest): Promise<void> {
    const turn: Turn = { aborted: false, done: false, prompted: false };
    this.turn = turn;
    this.emit({ type: "run_start" });
    this.emit({ type: "state", state: { isRunning: true } });
    for (const event of this.translator.userMessage(request.text, request.images)) this.emit(event);

    let connected: Connected;
    try {
      connected = await this.connect();
    } catch (err) {
      return this.finishTurn(turn, { error: (err as Error).message });
    }
    if (turn.aborted || turn.done) return this.finishTurn(turn, { stopReason: "cancelled" });

    const prompt: AcpContentBlock[] = [];
    if (request.text) prompt.push({ type: "text", text: request.text });
    if (request.images?.length) {
      if (connected.capabilities.promptCapabilities?.image) {
        for (const image of request.images) prompt.push({ type: "image", mimeType: image.mimeType, data: image.data });
      } else {
        for (const event of this.translator.notice("warning", `${this.label} doesn't accept images; they weren't sent.`)) this.emit(event);
      }
    }
    if (!prompt.length) prompt.push({ type: "text", text: "" });
    turn.prompted = true;
    try {
      const response = await connected.process.connection.agent.request("session/prompt", { sessionId: connected.sessionId, prompt });
      const usage = response.usage;
      if (usage) {
        this.totals.input += usage.inputTokens;
        this.totals.output += usage.outputTokens;
        this.totals.cacheRead += usage.cachedReadTokens ?? 0;
        this.totals.cacheWrite += usage.cachedWriteTokens ?? 0;
        this.totals.total += usage.totalTokens;
        this.emit({ type: "state", state: { sessionStats: { tokens: { ...this.totals }, cost: this.cost } } });
      }
      this.finishTurn(turn, { stopReason: response.stopReason });
    } catch (err) {
      if (turn.aborted) return this.finishTurn(turn, { stopReason: "cancelled" });
      // The connection closes a moment before the process reports its exit: prefer the exit's
      // message (exit code + stderr), which `onProcessExit` puts on the turn.
      const exit = await exitSoon(connected.process, 1000);
      this.finishTurn(turn, exit ? { error: exit.message } : errorEnd(err));
    }
  }

  private finishTurn(turn: Turn, end: TurnEnd): void {
    if (turn.done) return;
    turn.done = true;
    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    }
    this.cancelPermissions();
    for (const event of this.translator.finish(end)) this.emit(event);
    if (this.turn === turn) this.turn = null;
    this.emit({ type: "state", state: { isRunning: false } });
    this.emit({ type: "run_end" });
    // Like pi, a stopped or failed run doesn't send the queued follow-ups; they wait for the next run.
    const finished = !turn.aborted && !("error" in end) && end.stopReason !== "cancelled" && end.stopReason !== "refusal";
    const next = this.disposed || !finished ? undefined : this.queue.shift();
    if (next) {
      this.emitQueue();
      void this.runTurn(next);
    }
  }

  private emitQueue(): void {
    this.emit({ type: "state", state: { queue: { steering: [], followUp: this.queue.map((q) => q.text) } } });
  }

  // Connection ----------------------------------------------------------------------------------

  private connect(): Promise<Connected> {
    if (this.connected?.process.alive) return Promise.resolve(this.connected);
    this.connecting ??= this.start().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async start(): Promise<Connected> {
    const handlers: AcpClientHandlers = {
      sessionUpdate: (params) => this.onSessionUpdate(params),
      requestPermission: (params, signal) => this.onRequestPermission(params, signal),
      readTextFile: (params) => this.onReadTextFile(params),
      writeTextFile: (params) => this.onWriteTextFile(params),
    };
    const { config, cwd } = this.options;
    const proc =
      this.options.startProcess?.(handlers) ??
      new AcpProcess({ command: config.command, args: config.args, cwd, env: piChildEnv(process.env, config.env), handlers, log: this.options.log });
    const exited = new Promise<never>((_, reject) => {
      proc.onExit((error) => {
        this.onProcessExit(proc, error);
        reject(error ?? new Error(`${this.label} exited while starting`));
      });
    });
    exited.catch(() => {});
    const call = <T>(promise: Promise<T>) => Promise.race([promise, exited]);
    const agent = proc.connection.agent;
    try {
      const init = await call(
        agent.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
          clientInfo: { name: "glade", title: "Glade", version: this.options.clientVersion ?? "0.1.0" },
        }),
      );
      if (init.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`${this.label} speaks ACP version ${init.protocolVersion}; Glade supports version ${PROTOCOL_VERSION}`);
      }
      const capabilities = init.agentCapabilities ?? {};
      const previous = this.file.acpSessionId;
      let sessionId: string | null = null;
      let modes: { currentModeId: string } | null | undefined;
      if (previous && capabilities.loadSession) {
        // The agent replays the history as session/updates; no turn is active, so they're ignored.
        try {
          modes = (await call(agent.request("session/load", { sessionId: previous, cwd, mcpServers: [] }))).modes;
          sessionId = previous;
        } catch (err) {
          this.options.log?.(`${this.options.harnessId}: session/load failed: ${(err as Error).message}`);
        }
      } else if (previous && capabilities.sessionCapabilities?.resume) {
        try {
          modes = (await call(agent.request("session/resume", { sessionId: previous, cwd, mcpServers: [] }))).modes;
          sessionId = previous;
        } catch (err) {
          this.options.log?.(`${this.options.harnessId}: session/resume failed: ${(err as Error).message}`);
        }
      }
      if (!sessionId) {
        const created = await call(agent.request("session/new", { cwd, mcpServers: [] }));
        sessionId = created.sessionId;
        modes = created.modes;
        if (previous) {
          for (const event of this.translator.notice("info", `${this.label} started a new session: it doesn't remember the earlier messages of this chat.`)) {
            this.emit(event);
          }
        }
      }
      if (modes?.currentModeId) this.modeId = modes.currentModeId;
      if (this.file.acpSessionId !== sessionId) {
        this.file = { ...this.file, acpSessionId: sessionId };
        this.persist();
      }
      const connected: Connected = { process: proc, sessionId, capabilities };
      if (this.disposed) {
        await proc.kill();
        throw new Error("The session is closed");
      }
      this.connected = connected;
      return connected;
    } catch (err) {
      // A dead agent closes the connection first; its exit (spawn error, stderr) explains more.
      const exit = await exitSoon(proc, 500);
      await proc.kill().catch(() => {});
      throw startError(exit ?? err, this.label, config.command);
    }
  }

  private onProcessExit(proc: AcpProcess, error: Error | null): void {
    if (this.connected?.process !== proc) return; // still starting (the caller reports it) or replaced
    this.connected = null;
    if (this.disposed) return;
    this.cancelPermissions();
    const turn = this.turn;
    if (turn && !turn.done) this.finishTurn(turn, { error: error?.message ?? `${this.label} exited` });
    this.events.exit(error);
  }

  // Client-side methods ---------------------------------------------------------------------------

  private onSessionUpdate(params: SessionNotification): void {
    if (this.disposed) return;
    const { update } = params;
    switch (update.sessionUpdate) {
      case "available_commands_update":
        this.commands = update.availableCommands.map(toSlashCommand);
        return;
      case "current_mode_update":
        this.modeId = update.currentModeId;
        return;
      case "usage_update": {
        const percent = update.size > 0 ? (update.used / update.size) * 100 : null;
        const state: Partial<SessionState> = { contextUsage: { tokens: update.used, contextWindow: update.size, percent } };
        if (update.cost && update.cost.currency.toUpperCase() === "USD") {
          this.cost = update.cost.amount;
          state.sessionStats = { tokens: { ...this.totals }, cost: this.cost };
        }
        this.emit({ type: "state", state });
        return;
      }
    }
    // Content only while a prompt turn runs, and only for our session (replays are ignored).
    const turn = this.turn;
    if (!turn || !turn.prompted || turn.done || params.sessionId !== this.connected?.sessionId) return;
    for (const event of this.translator.update(update)) this.emit(event);
  }

  private onRequestPermission(params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const turn = this.turn;
    if (this.disposed || !turn || turn.aborted || turn.done) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    for (const event of this.translator.permissionToolCall(params.toolCall)) this.emit(event);
    const tool = this.translator.toolState(params.toolCall.toolCallId);
    const id = `perm-${this.sessionRef.slice(0, 8)}-${++this.permissionSeq}`;
    const summary = tool ? acpToolSummary(tool) : undefined;
    const request: UiRequest & { kind: "permission" } = {
      id,
      kind: "permission",
      title: tool?.title || params.toolCall.title || "Allow this tool call?",
      ...(summary ? { message: summary } : {}),
      toolCallId: params.toolCall.toolCallId,
      options: params.options.map((o) => ({ id: o.optionId, label: o.name, kind: o.kind })),
    };
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.permissions.set(id, { request, resolve });
      signal.addEventListener("abort", () => {
        if (!this.permissions.delete(id)) return;
        resolve({ outcome: { outcome: "cancelled" } });
        this.emit({ type: "ui_request_closed", id });
      });
      this.emit({ type: "ui_request", request });
    });
  }

  private cancelPermissions(): void {
    for (const [id, pending] of [...this.permissions]) {
      this.permissions.delete(id);
      pending.resolve({ outcome: { outcome: "cancelled" } });
      this.emit({ type: "ui_request_closed", id });
    }
  }

  private async onReadTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    this.checkSession(params.sessionId);
    try {
      return { content: await readTextFile(this.options.cwd, params.path, params.line, params.limit) };
    } catch (err) {
      throw fsError(err);
    }
  }

  private async onWriteTextFile(params: WriteTextFileRequest): Promise<void> {
    this.checkSession(params.sessionId);
    try {
      await writeTextFile(this.options.cwd, params.path, params.content);
    } catch (err) {
      throw fsError(err);
    }
  }

  private checkSession(sessionId: string): void {
    if (sessionId !== this.connected?.sessionId && sessionId !== this.file.acpSessionId) {
      throw RequestError.invalidParams(undefined, `Unknown session ${sessionId}`);
    }
  }

  // Events + persistence ------------------------------------------------------------------------

  private emit(event: AgentEvent): void {
    if (event.type === "state") this.state = { ...this.state, ...event.state };
    this.transcript = applyAgentEvent(this.transcript, event);
    this.events.emit(event);
  }

  /** Save the ACP session id and title (the conversation is saved by Glade's store). */
  private persist(): void {
    try {
      this.options.store.save(this.sessionRef, this.file);
    } catch (err) {
      this.options.log?.(`${this.options.harnessId}: could not save the session: ${(err as Error).message}`);
    }
  }
}

/** The process's exit error if it exits within `ms` (else `undefined`; a clean exit is `null`). */
function exitSoon(proc: AcpProcess, ms: number): Promise<Error | null | undefined> {
  return Promise.race([proc.whenExited, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref())]);
}

function toSlashCommand(command: AvailableCommand): SlashCommand {
  const hint = command.input && "hint" in command.input ? command.input.hint : undefined;
  return { name: command.name, description: command.description, source: "extension", ...(hint ? { argsHint: hint } : {}) };
}

function errorEnd(err: unknown): TurnEnd {
  if (err instanceof RequestError) {
    const details = err.data === undefined ? undefined : typeof err.data === "string" ? err.data : JSON.stringify(err.data);
    return { error: err.message, ...(details ? { details } : {}) };
  }
  return { error: (err as Error)?.message ?? String(err) };
}

/** A clear message for failures while starting the agent (sign-in needed, bad command, …). */
function startError(err: unknown, label: string, command: string): Error {
  if (err instanceof RequestError && err.code === AUTH_REQUIRED) {
    return new Error(`${label} needs you to sign in first. Run \`${command}\` in a terminal to log in (see the agent's docs), then try again.`);
  }
  const message = (err as Error)?.message ?? String(err);
  return new Error(message.startsWith("Could not start") || message.includes(label) ? message : `${label}: ${message}`);
}

function fsError(err: unknown): Error {
  if (err instanceof FsAccessError) return RequestError.invalidParams(undefined, err.message);
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return RequestError.resourceNotFound((err as NodeJS.ErrnoException).path);
  return RequestError.internalError(undefined, (err as Error)?.message);
}
