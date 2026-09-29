/**
 * One Glade chat with Codex (I-177): a thread in the shared `codex app-server` (`app-server.ts`).
 *
 * - **Thread:** the session ref *is* Codex's thread id. A new chat starts its thread when it opens
 *   (`thread/start`, no model call; Codex saves it only once a turn ran); a chat reopened resumes
 *   it (`thread/resume`, metadata only: the conversation is Glade's, the store's, I-121). A thread
 *   Codex no longer has starts fresh. Glade's sub-agent and chat tools go in as dynamic tools
 *   (Codex keeps them with the thread) and are answered here (`item/tool/call`).
 * - **Turns:** `turn/start` with the chat's model, effort and permission mode (Codex applies them
 *   to this and later turns, so changes need no restart). `run_end` after `turn/completed` (unless
 *   queued follow-ups go on). A message sent while running steers (`turn/steer`); a follow-up
 *   waits for the run to end and stays queued when it's stopped or fails.
 * - **Stop:** `turn/interrupt`; without `turn/completed` within a grace period the turn ends anyway.
 * - **Approvals:** command and file-change requests become permission cards worded like Codex's
 *   own prompt (`permissions.ts`); "No, and tell Codex …" cancels the turn (it ends Stopped, the
 *   composer gets the focus). Questions (`item/tool/requestUserInput`) become select/input dialogs;
 *   MCP elicitations are declined.
 * - **Permission modes (I-174):** Read only / Auto / Full access, per chat, sent with each turn; a
 *   switch mid-run applies from the next turn.
 * - **Limits and errors:** a turn refused for the usage limit ends with "Codex usage limit reached
 *   — resets <date>" (`errors.ts`, dates from `account/rateLimits/read`); sign-in problems say how
 *   to log in. Token usage feeds the context meter and session stats.
 * - **Compaction:** `thread/compact/start`; its turn runs silently apart from the notice.
 * - **Slash commands (I-178, `commands.ts`):** Codex's skills (`skills/list` for the chat's folder)
 *   and `/review`. `/<skill> rest` sends a skill item; `/review …` runs `review/start` as the
 *   turn (its review is the reply). A review sent while a turn runs waits as a follow-up.
 * - **`!cmd` / `!!cmd` (I-178):** `command/exec` in the chat's folder, in the chat's permission
 *   mode's sandbox, output streamed as `shell_*` events; allowed while a turn runs. A shared
 *   (`!`) command is added to Codex's history as Codex records its own `!` commands
 *   (`thread/inject_items`) right away when idle, else with the next message (as text before it).
 * - The app-server ending fails the running turn and exits the session (`onExit`); the next prompt
 *   opens the chat again in a new process, which resumes the thread.
 */
import { StringDecoder } from "node:string_decoder";
import {
  applyAgentEvent,
  clampThinkingLevel,
  defaultSessionState,
  emptyTranscript,
  type AgentEvent,
  type CompactResult,
  type ModelRef,
  type PermissionOption,
  type PromptRequest,
  type SessionState,
  type ShellResult,
  type SlashCommand,
  type ThinkingLevel,
  type Transcript,
  type UiRequest,
  type UiResponse,
} from "@glade/protocol";
import { SessionEvents } from "../session-events.js";
import type { HarnessSession, ShellRunRequest } from "../types.js";
import type { CodexAppServer, ThreadListener } from "./app-server.js";
import { codexSlashCommands, parseSlashText, reviewTarget, shellArgv, skillInput, userShellItem, userShellRecord } from "./commands.js";
import { NOT_LOGGED_IN, friendlyTurnError, usageLimitMessage } from "./errors.js";
import { CODEX_PROVIDER, DEFAULT_CONTEXT_WINDOW, codexModelId, codexThinkingLevels, defaultLevel, effortToLevel, findCodexModel, levelToEffort } from "./models.js";
import {
  CODEX_DEFAULT_MODE,
  REJECT,
  codexPermissionModes,
  commandApproval,
  commandDecision,
  fileChangeApproval,
  fileChangeDecision,
  isCodexPermissionMode,
  modeFromConfig,
  threadPermissions,
  turnPermissions,
  type CodexPermissionMode,
} from "./permissions.js";
import { CodexRpcError } from "./rpc.js";
import type {
  CodexModel,
  CommandExecutionRequestApprovalParams,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
  FileChangeRequestApprovalParams,
  PermissionsRequestApprovalParams,
  ReviewStartResponse,
  ReviewTarget,
  ServerNotifications,
  ThreadStartResponse,
  ToolRequestUserInputParams,
  Turn as CodexTurn,
  TurnStartResponse,
  UserInput,
} from "./protocol.js";
import { itemSummary } from "./tools.js";
import { CodexTranslator, type TurnEnd } from "./translate.js";

const LABEL = "Codex";
/** Output kept per stream of a `!cmd` (`command/exec`'s `outputBytesCap`). */
const SHELL_OUTPUT_CAP = 1024 * 1024;
const COMPACT_TIMEOUT_MS = 5 * 60_000;

/** One of Glade's own tools, run in the Glade server when Codex calls it. */
export interface CodexGladeTool {
  spec: DynamicToolSpec;
  run(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }>;
}

export interface CodexSessionOptions {
  server: CodexAppServer;
  cwd: string;
  /** The thread to resume, `null` for a new chat. */
  sessionRef: string | null;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
  /** The chat's saved permission mode; absent: Codex's configured preset. */
  permissionMode?: string | null;
  /** Developer instructions for the thread (a sub-agent's role). */
  developerInstructions?: string;
  /** Glade's tools for this chat (dynamic tools), read when a thread starts. */
  gladeTools?: () => CodexGladeTool[];
  /** The user's shell for `!cmd` (default: `/bin/zsh`). */
  shell?: string;
  /** How long to wait for an interrupted turn's `turn/completed`. */
  cancelGraceMs?: number;
  log?: (msg: string) => void;
}

interface Turn {
  id: string | null;
  aborted: boolean;
  done: boolean;
  compact?: { resolve: (r: CompactResult) => void; reject: (e: Error) => void; before: number | null; after: number | null };
}

interface PendingUi {
  resolve: (response: UiResponse | null) => void;
}

export class CodexSession implements HarnessSession {
  private ref: string | null;
  private readonly events: SessionEvents;
  private state: SessionState;
  private transcript: Transcript = emptyTranscript();
  private readonly translator: CodexTranslator;
  /** The thread is loaded in the running app-server. */
  private loaded = false;
  private unregister: (() => void) | null = null;
  private turn: Turn | null = null;
  private readonly queue: PromptRequest[] = [];
  private readonly pendingUi = new Map<string, PendingUi>();
  private uiSeq = 0;
  private disposed = false;
  private cancelTimer: NodeJS.Timeout | null = null;
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
  private models: CodexModel[] = [];
  private tools: CodexGladeTool[] = [];
  /** Shared `!cmd` records not in Codex's history yet (sent with the next message). */
  private readonly shellContext: string[] = [];
  /** Running `!cmd`s: Glade's shell id → `command/exec` process id. */
  private readonly shells = new Map<string, string>();
  private readonly stoppedShells = new Set<string>();
  /** The error Codex reported for the running turn (`error` notification), for `turn/completed`. */
  private lastError: CodexTurn["error"] = null;

  constructor(private readonly options: CodexSessionOptions) {
    this.ref = options.sessionRef;
    this.events = new SessionEvents(options.log);
    const mode = isCodexPermissionMode(options.permissionMode) ? options.permissionMode : CODEX_DEFAULT_MODE;
    this.state = {
      ...defaultSessionState(),
      model: codexModelId(options.model) ? options.model : null,
      thinkingLevel: options.thinkingLevel ?? "medium",
      thinkingLevels: codexThinkingLevels(undefined),
      permissionMode: mode,
      permissionModes: codexPermissionModes(),
    };
    this.translator = new CodexTranslator(`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`);
  }

  get sessionRef(): string | null {
    return this.ref;
  }

  /**
   * Open the thread: resume the chat's (a missing one starts fresh), or start a new one. A chat
   * that can't reach Codex now still opens (its thread is resumed with the next prompt); a new
   * chat can't, it needs its thread id.
   */
  async init(): Promise<void> {
    const { server } = this.options;
    this.models = await server.listModels().catch(() => [] as CodexModel[]);
    const config = await server.config().catch(() => null);
    if (!isCodexPermissionMode(this.options.permissionMode)) this.state.permissionMode = modeFromConfig(config);
    if (!this.state.model) {
      const id = config?.model ?? this.models.find((m) => m.isDefault)?.id ?? null;
      if (id) this.state.model = { provider: CODEX_PROVIDER, id };
    }
    const info = findCodexModel(this.models, codexModelId(this.state.model));
    const levels = codexThinkingLevels(info);
    const level = this.options.thinkingLevel ?? defaultLevel(info, info && config?.model === info.id ? config.model_reasoning_effort : null);
    this.state.thinkingLevels = levels;
    this.state.thinkingLevel = clampThinkingLevel(levels, level);
    if (this.ref) {
      try {
        await this.openThread();
      } catch (err) {
        this.options.log?.(`codex ${this.ref}: couldn't resume the thread yet: ${(err as Error).message}`);
      }
    } else {
      await this.openThread();
    }
  }

  private mode(): CodexPermissionMode {
    return isCodexPermissionMode(this.state.permissionMode) ? this.state.permissionMode : CODEX_DEFAULT_MODE;
  }

  /** Resume (or start) the thread in the running app-server. */
  private async openThread(): Promise<void> {
    const { server, cwd } = this.options;
    const model = codexModelId(this.state.model);
    const common = {
      cwd,
      ...(model ? { model } : {}),
      ...threadPermissions(this.mode()),
      ...(this.options.developerInstructions ? { developerInstructions: this.options.developerInstructions } : {}),
    };
    if (this.ref) {
      const ref = this.ref;
      this.listen(ref); // notifications can come before the reply
      try {
        await server.request<ThreadStartResponse>("thread/resume", { threadId: ref, ...common, excludeTurns: true });
        this.loaded = true;
        return;
      } catch (err) {
        if (!isMissingThread(err)) throw err;
        this.options.log?.(`codex ${ref}: Codex doesn't have this thread any more; starting a new one`);
      }
    }
    this.tools = this.options.gladeTools?.() ?? [];
    const started = await server.request<ThreadStartResponse>("thread/start", {
      ...common,
      ...(this.tools.length ? { dynamicTools: this.tools.map((t) => t.spec) } : {}),
    });
    this.ref = started.thread.id;
    this.listen(this.ref);
    this.loaded = true;
    if (!this.state.model && started.model) this.setState({ model: { provider: CODEX_PROVIDER, id: started.model } });
    const level = effortToLevel(started.reasoningEffort);
    if (!this.options.thinkingLevel && level && this.state.thinkingLevels.includes(level)) this.setState({ thinkingLevel: level });
  }

  private listen(threadId: string): void {
    this.unregister?.();
    const listener: ThreadListener = {
      notification: (method, params) => this.onNotification(method, params),
      request: (method, params) => this.onRequest(method, params),
      closed: (error) => this.onServerClosed(error),
    };
    this.unregister = this.options.server.register(threadId, listener);
  }

  /** The thread is ready for a turn (resumed again after Codex unloaded it). */
  private async ensureThread(): Promise<string> {
    if (!this.loaded || !this.ref) await this.openThread();
    if (!this.ref) throw new Error("Codex has no thread for this chat");
    return this.ref;
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
    const turn = this.turn;
    if (turn?.compact) throw new Error("Wait for the compaction to finish");
    if (turn) {
      if (request.behavior === "followUp" || !turn.id || parseSlashText(request.text)?.name === "review") {
        this.queue.push(request);
        this.emitQueue();
        return;
      }
      await this.steer(turn, request);
      return;
    }
    void this.runTurn(request);
  }

  /** Add a message to the running turn (`turn/steer`); when Codex can't, it waits as a follow-up. */
  private async steer(turn: Turn, request: PromptRequest): Promise<void> {
    try {
      const { input } = await this.resolveInput(request);
      const context = this.takeShellContext();
      try {
        await this.options.server.request("turn/steer", { threadId: this.ref, input: [...context, ...input], expectedTurnId: turn.id });
      } catch (err) {
        this.restoreShellContext(context);
        throw err;
      }
      for (const event of this.translator.userMessage(request.text, request.images)) this.emit(event);
    } catch (err) {
      this.options.log?.(`codex: steering failed (${(err as Error).message}); queued as a follow-up`);
      this.queue.push(request);
      this.emitQueue();
    }
  }

  async abort(): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.done) return;
    turn.aborted = true;
    this.cancelUi();
    if (turn.id) this.interrupt(turn);
    // (Still starting: runTurn interrupts once the turn id is known.)
    this.cancelTimer = setTimeout(() => this.finishTurn(turn, { stopReason: "aborted" }), this.options.cancelGraceMs ?? 10_000);
    this.cancelTimer.unref?.();
  }

  private interrupt(turn: Turn): void {
    void this.options.server
      .request("turn/interrupt", { threadId: this.ref, turnId: turn.id })
      .catch((err: Error) => this.options.log?.(`codex: interrupt failed: ${err.message}`));
  }

  async setModel(model: ModelRef): Promise<void> {
    const id = codexModelId(model);
    if (!id) throw new Error(`${LABEL} can't use ${model.provider}/${model.id}`);
    this.models = await this.options.server.listModels().catch(() => this.models);
    const levels = codexThinkingLevels(findCodexModel(this.models, id));
    this.setState({ model, thinkingLevels: levels, thinkingLevel: clampThinkingLevel(levels, this.state.thinkingLevel) });
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    this.setState({ thinkingLevel: clampThinkingLevel(this.state.thinkingLevels, level) });
  }

  /** Read only / Auto / Full access: sent with the next turn (Codex applies it per turn). */
  async setPermissionMode(mode: string): Promise<void> {
    if (!isCodexPermissionMode(mode)) throw new Error(`${LABEL} can't switch to "${mode}" here`);
    if (this.state.permissionMode !== mode) this.setState({ permissionMode: mode });
  }

  /** Glade keeps the title (Codex's thread name isn't used). */
  async setTitle(_title: string): Promise<void> {}

  respondToUi(response: UiResponse): void {
    const pending = this.pendingUi.get(response.id);
    if (!pending) return;
    this.pendingUi.delete(response.id);
    pending.resolve(response);
  }

  /** Codex's commands and the skills of the chat's folder (`commands.ts`). */
  async listCommands(): Promise<SlashCommand[]> {
    return codexSlashCommands(await this.skills());
  }

  private skills() {
    return this.options.server.skills(this.options.cwd).catch((err: Error) => {
      this.options.log?.(`codex: listing skills failed: ${err.message}`);
      return [];
    });
  }

  /** What a prompt sends: a `/review`, a `/<skill>` (skill item), or the text and images. */
  private async resolveInput(request: PromptRequest): Promise<{ input: UserInput[]; review?: ReviewTarget }> {
    const slash = parseSlashText(request.text);
    if (slash?.name === "review") return { input: [], review: reviewTarget(slash.args) };
    const skill = slash ? (await this.skills()).find((s) => s.name === slash.name) : undefined;
    if (!slash || !skill) return { input: userInput(request) };
    return { input: [...skillInput(skill, slash.args), ...userInput({ ...request, text: "" }).filter((i) => i.type !== "text")] };
  }

  /**
   * `!cmd` / `!!cmd`: `command/exec` in the chat's folder with the chat's sandbox (see the
   * header). Never rejects.
   */
  async runShell({ id, command, shareWithAgent }: ShellRunRequest): Promise<ShellResult> {
    const startedAt = Date.now();
    this.emit({ type: "shell_start", id, command, shared: shareWithAgent, at: startedAt });
    const processId = `glade-${id}`;
    this.shells.set(id, processId);
    let output = "";
    let truncated = false;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let result: ShellResult;
    try {
      const response = await this.options.server.exec(
        {
          command: shellArgv(command, this.options.shell),
          processId,
          cwd: this.options.cwd,
          disableTimeout: true,
          outputBytesCap: SHELL_OUTPUT_CAP,
          // The user typed it: unsandboxed, like `!` in Codex's own TUI and in pi (I-178).
          sandboxPolicy: { type: "dangerFullAccess" },
        },
        (delta) => {
          if (delta.capReached) truncated = true;
          const text = decoders[delta.stream].write(Buffer.from(delta.deltaBase64, "base64"));
          if (!text || this.disposed) return;
          output += text;
          this.emit({ type: "shell_update", id, delta: text });
        },
      );
      const tail = decoders.stdout.end() + decoders.stderr.end() + response.stdout + response.stderr;
      if (tail) {
        output += tail;
        this.emit({ type: "shell_update", id, delta: tail });
      }
      const cancelled = this.stoppedShells.has(id);
      result = { output, exitCode: cancelled ? null : response.exitCode, cancelled, truncated };
    } catch (err) {
      result = { output, exitCode: null, cancelled: this.stoppedShells.has(id), truncated, error: (err as Error).message };
    } finally {
      this.shells.delete(id);
      this.stoppedShells.delete(id);
    }
    this.emit({ type: "shell_end", id, result, at: Date.now() });
    if (shareWithAgent && !result.error) await this.shareShell(userShellRecord(command, result.exitCode, Date.now() - startedAt, result.output));
    return result;
  }

  async abortShell(): Promise<void> {
    await Promise.all(
      [...this.shells].map(([id, processId]) => {
        this.stoppedShells.add(id);
        return this.options.server.terminate(processId).catch((err: Error) => this.options.log?.(`codex: stopping ${id} failed: ${err.message}`));
      }),
    );
  }

  /** Put a shared `!cmd` into Codex's history now when idle, else with the next message. */
  private async shareShell(record: string): Promise<void> {
    if (this.turn || this.disposed) {
      this.shellContext.push(record);
      return;
    }
    try {
      const threadId = await this.ensureThread();
      await this.options.server.request("thread/inject_items", { threadId, items: [userShellItem(record)] });
    } catch (err) {
      this.options.log?.(`codex: couldn't add the command to the thread (${(err as Error).message}); it goes with the next message`);
      this.shellContext.push(record);
    }
  }

  /** Shared `!cmd`s waiting for the next message, as its first input items. */
  private takeShellContext(): UserInput[] {
    return this.shellContext.splice(0).map((text) => ({ type: "text", text, text_elements: [] }));
  }

  private restoreShellContext(items: UserInput[]): void {
    this.shellContext.unshift(...items.map((i) => (i.type === "text" ? i.text : "")).filter(Boolean));
  }

  async compact(): Promise<CompactResult> {
    if (this.turn) throw new Error("Wait for the current reply to finish before compacting");
    const turn: Turn = { id: null, aborted: false, done: false };
    const result = new Promise<CompactResult>((resolve, reject) => {
      turn.compact = { resolve, reject, before: this.state.contextUsage?.tokens ?? null, after: null };
    });
    this.turn = turn;
    this.setState({ isCompacting: true });
    try {
      const threadId = await this.ensureThread();
      await this.options.server.request("thread/compact/start", { threadId });
    } catch (err) {
      this.finishTurn(turn, { stopReason: "error", errorMessage: (err as Error).message });
    }
    const timer = setTimeout(() => this.finishTurn(turn, { stopReason: "error", errorMessage: "Compaction timed out" }), COMPACT_TIMEOUT_MS);
    timer.unref?.();
    try {
      return await result;
    } finally {
      clearTimeout(timer);
    }
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
    this.cancelUi();
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    const turn = this.turn;
    if (turn && !turn.done && turn.id) this.interrupt(turn);
    for (const processId of this.shells.values()) void this.options.server.terminate(processId).catch(() => {});
    this.unregister?.();
    this.unregister = null;
    // Let the app-server unload the thread (it stays saved).
    if (this.loaded && this.ref) void this.options.server.request("thread/unsubscribe", { threadId: this.ref }, 5_000).catch(() => {});
    this.loaded = false;
  }

  // Turns ---------------------------------------------------------------------------------------

  private async runTurn(request: PromptRequest): Promise<void> {
    const turn: Turn = { id: null, aborted: false, done: false };
    this.startRun(turn);
    for (const event of this.translator.userMessage(request.text, request.images)) this.emit(event);
    const { server } = this.options;
    try {
      if (!(await server.loggedIn())) throw new Error(NOT_LOGGED_IN);
      // The usage is used up: say so (with the reset date) instead of sending a turn Codex refuses.
      const blocked = await server.usageBlocked();
      if (blocked) {
        const plan = blocked.rateLimits.planType ? ` (${blocked.rateLimits.planType} plan)` : "";
        return this.finishTurn(turn, { stopReason: "error", errorMessage: usageLimitMessage(blocked.rateLimits), errorDetails: `Codex reports no usage left on this account${plan}; nothing was sent.` });
      }
      if (turn.aborted) return this.finishTurn(turn, { stopReason: "aborted" });
      const { input, review } = await this.resolveInput(request);
      if (turn.aborted) return this.finishTurn(turn, { stopReason: "aborted" });
      const context = review ? [] : this.takeShellContext();
      const start = (threadId: string): Promise<TurnStartResponse | ReviewStartResponse> =>
        review
          ? server.request<ReviewStartResponse>("review/start", { threadId, target: review, delivery: "inline" })
          : server.request<TurnStartResponse>("turn/start", {
              threadId,
              input: [...context, ...input],
              ...(codexModelId(this.state.model) ? { model: codexModelId(this.state.model) } : {}),
              effort: levelToEffort(this.state.thinkingLevel),
              ...turnPermissions(this.mode()),
            });
      let started: TurnStartResponse | ReviewStartResponse;
      try {
        try {
          started = await start(await this.ensureThread());
        } catch (err) {
          if (!isMissingThread(err)) throw err;
          this.loaded = false; // Codex unloaded it: resume and try once more
          started = await start(await this.ensureThread());
        }
      } catch (err) {
        this.restoreShellContext(context);
        throw err;
      }
      if (turn.done) return;
      turn.id ??= started.turn.id;
      if (turn.aborted) this.interrupt(turn);
    } catch (err) {
      this.finishTurn(turn, { stopReason: "error", errorMessage: (err as Error).message });
    }
  }

  private startRun(turn: Turn): void {
    this.turn = turn;
    this.lastError = null;
    this.emit({ type: "run_start" });
    this.emit({ type: "state", state: { isRunning: true } });
  }

  private finishTurn(turn: Turn, end: TurnEnd): void {
    if (turn.done) return;
    turn.done = true;
    if (this.cancelTimer) {
      clearTimeout(this.cancelTimer);
      this.cancelTimer = null;
    }
    this.cancelUi();
    if (this.turn === turn) this.turn = null;
    if (turn.compact) {
      this.setState({ isCompacting: false });
      if (end.stopReason === "stop") turn.compact.resolve({ tokensBefore: turn.compact.before ?? 0, tokensAfter: turn.compact.after });
      else turn.compact.reject(new Error(end.errorMessage ?? "Compaction was stopped"));
      this.translator.finish({ stopReason: "stop" });
    } else {
      for (const event of this.translator.finish(end)) this.emit(event);
      this.emit({ type: "state", state: { isRunning: false } });
      this.emit({ type: "run_end" });
    }
    const finished = !turn.compact && !turn.aborted && end.stopReason !== "error" && end.stopReason !== "aborted";
    const next = this.disposed || !finished ? undefined : this.queue.shift();
    if (next) {
      this.emitQueue();
      void this.runTurn(next);
    }
  }

  private emitQueue(): void {
    this.emit({ type: "state", state: { queue: { steering: [], followUp: this.queue.map((q) => q.text) } } });
  }

  /** How a `turn/completed` ends the turn. */
  private async turnEnd(turn: Turn, completed: CodexTurn): Promise<TurnEnd> {
    if (turn.aborted || completed.status === "interrupted") return { stopReason: "aborted" };
    if (completed.status !== "failed") return { stopReason: "stop" };
    const error = completed.error ?? this.lastError;
    const code = error?.codexErrorInfo;
    const limited = code === "usageLimitExceeded" || code === "rateLimitExceeded" || /usage limit/i.test(error?.message ?? "");
    const limits = limited ? await this.options.server.rateLimits() : this.options.server.knownRateLimits();
    const friendly = friendlyTurnError(error, limits);
    return { stopReason: "error", errorMessage: friendly.message, ...(friendly.details ? { errorDetails: friendly.details } : {}) };
  }

  // Notifications ---------------------------------------------------------------------------------

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (this.disposed) return;
    const p = params as never;
    switch (method) {
      case "turn/started": {
        const { turn } = p as ServerNotifications["turn/started"];
        if (!this.turn) this.startRun({ id: turn.id, aborted: false, done: false }); // a turn Codex started itself
        else this.turn.id ??= turn.id;
        return;
      }
      case "turn/completed": {
        const { turn: completed } = p as ServerNotifications["turn/completed"];
        const turn = this.turn;
        if (!turn || (turn.id && turn.id !== completed.id)) return;
        turn.id ??= completed.id;
        void this.turnEnd(turn, completed).then((end) => this.finishTurn(turn, end));
        return;
      }
      case "error": {
        const { error, willRetry } = p as ServerNotifications["error"];
        if (willRetry) this.emit({ type: "notify", level: "warning", message: `${LABEL}: ${error.message} (retrying)` });
        else this.lastError = error;
        return;
      }
      case "warning": {
        const { message } = p as ServerNotifications["warning"];
        if (message) this.emit({ type: "notify", level: "warning", message: `${LABEL}: ${message}` });
        return;
      }
      case "thread/tokenUsage/updated":
        return this.onUsage(p as ServerNotifications["thread/tokenUsage/updated"]);
      case "thread/status/changed": {
        const { status } = p as ServerNotifications["thread/status/changed"];
        if (status?.type === "notLoaded") this.loaded = false;
        return;
      }
      case "thread/closed":
        this.loaded = false;
        return;
      case "model/rerouted": {
        const { toModel } = p as ServerNotifications["model/rerouted"];
        this.emit({ type: "notify", level: "info", message: `${LABEL} switched this turn to ${toModel}` });
        return;
      }
    }
    const turn = this.turn;
    if (!turn) return;
    if (turn.compact) {
      if (method === "item/completed" && (p as ServerNotifications["item/completed"]).item.type === "contextCompaction") {
        for (const event of this.translator.notice("compaction", "Context compacted")) this.emit(event);
      }
      return;
    }
    const events = this.translate(method, p);
    for (const event of events) this.emit(event);
  }

  private translate(method: string, p: never): AgentEvent[] {
    const t = this.translator;
    switch (method) {
      case "item/started":
        return t.itemStarted((p as ServerNotifications["item/started"]).item);
      case "item/completed":
        return t.itemCompleted((p as ServerNotifications["item/completed"]).item);
      case "item/agentMessage/delta":
      case "item/plan/delta": {
        const { itemId, delta } = p as ServerNotifications["item/agentMessage/delta"];
        return t.agentDelta(itemId, delta);
      }
      case "item/reasoning/summaryTextDelta": {
        const { itemId, delta, summaryIndex } = p as ServerNotifications["item/reasoning/summaryTextDelta"];
        return t.reasoningSummaryDelta(itemId, delta, summaryIndex);
      }
      case "item/reasoning/textDelta": {
        const { itemId, delta } = p as ServerNotifications["item/reasoning/textDelta"];
        return t.reasoningTextDelta(itemId, delta);
      }
      case "item/commandExecution/outputDelta": {
        const { itemId, delta } = p as ServerNotifications["item/commandExecution/outputDelta"];
        return t.commandOutput(itemId, delta);
      }
      case "item/fileChange/patchUpdated": {
        const { itemId, changes } = p as ServerNotifications["item/fileChange/patchUpdated"];
        return t.patchUpdated(itemId, changes);
      }
      case "turn/plan/updated": {
        const { plan, explanation } = p as ServerNotifications["turn/plan/updated"];
        return t.plan(plan, explanation);
      }
      default:
        return [];
    }
  }

  private onUsage({ tokenUsage }: ServerNotifications["thread/tokenUsage/updated"]): void {
    if (tokenUsage.modelContextWindow && tokenUsage.modelContextWindow > 0) this.contextWindow = tokenUsage.modelContextWindow;
    const last = tokenUsage.last;
    const total = tokenUsage.total;
    const tokens = last.totalTokens || last.inputTokens + last.outputTokens;
    if (this.turn?.compact) this.turn.compact.after = tokens;
    const cacheRead = total.cachedInputTokens ?? 0;
    this.setState({
      contextUsage: { tokens, contextWindow: this.contextWindow, percent: (tokens / this.contextWindow) * 100 },
      sessionStats: {
        tokens: { input: Math.max(0, total.inputTokens - cacheRead), output: total.outputTokens, cacheRead, cacheWrite: total.cacheWriteInputTokens ?? 0, total: total.totalTokens },
        cost: 0,
      },
    });
  }

  private onServerClosed(error: Error | null): void {
    this.loaded = false;
    if (this.disposed) return;
    const message = `${LABEL} stopped: ${error?.message ?? "codex app-server exited"}`;
    const turn = this.turn;
    if (turn && !turn.done) this.finishTurn(turn, { stopReason: "error", errorMessage: message });
    this.events.exit(new Error(message));
  }

  // Requests from Codex ------------------------------------------------------------------------------

  private async onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval":
        return this.approveCommand(params as unknown as CommandExecutionRequestApprovalParams);
      case "item/fileChange/requestApproval":
        return this.approveFileChange(params as unknown as FileChangeRequestApprovalParams);
      case "item/permissions/requestApproval":
        return this.approvePermissions(params as unknown as PermissionsRequestApprovalParams);
      case "item/tool/requestUserInput":
        return this.askQuestions(params as unknown as ToolRequestUserInputParams);
      case "item/tool/call":
        return this.callTool(params as unknown as DynamicToolCallParams);
      case "mcpServer/elicitation/request":
        return { action: "decline", content: null, _meta: null };
      default:
        throw new CodexRpcError(`Glade doesn't handle ${method}`, -32601);
    }
  }

  /** Whether a request can still be asked (a live, running, not stopped turn). */
  private canAsk(): Turn | null {
    const turn = this.turn;
    return this.disposed || !turn || turn.aborted || turn.done ? null : turn;
  }

  private async approveCommand(params: CommandExecutionRequestApprovalParams): Promise<unknown> {
    const turn = this.canAsk();
    if (!turn) return { decision: "cancel" };
    const card = commandApproval(params);
    const toolCallId = this.translator.toolCallId(params.itemId);
    const value = await this.askPermission({ ...card, ...(toolCallId ? { toolCallId } : {}) });
    const decision = commandDecision(value, params);
    if (decision === "cancel") this.reject(turn, params.itemId);
    return { decision };
  }

  private async approveFileChange(params: FileChangeRequestApprovalParams): Promise<unknown> {
    const turn = this.canAsk();
    if (!turn) return { decision: "cancel" };
    const card = fileChangeApproval(itemSummary(this.translator.item(params.itemId)), params.reason ?? (params.grantRoot ? `write access to ${params.grantRoot}` : null));
    const toolCallId = this.translator.toolCallId(params.itemId);
    const value = await this.askPermission({ ...card, ...(toolCallId ? { toolCallId } : {}) });
    const decision = fileChangeDecision(value);
    if (decision === "cancel") this.reject(turn, params.itemId);
    return { decision };
  }

  /** Extra permissions (network, folders) for this turn or the session. */
  private async approvePermissions(params: PermissionsRequestApprovalParams): Promise<unknown> {
    const turn = this.canAsk();
    const denied = { permissions: {}, scope: "turn" };
    if (!turn) return denied;
    const value = await this.askPermission({
      title: "Would you like to give Codex more permissions?",
      ...(params.reason ? { message: params.reason } : {}),
      options: [
        { id: "turn", label: "Yes, for this turn", kind: "allow_once" },
        { id: "session", label: "Yes, for this session", kind: "allow_always" },
        { id: REJECT, label: "No, and tell Codex what to do differently", kind: "reject_once", focusComposer: true },
      ],
    });
    const granted = Object.fromEntries(Object.entries(params.permissions ?? {}).filter(([, v]) => v !== null && v !== undefined));
    if (value === "turn" || value === "session") return { permissions: granted, scope: value };
    if (value === REJECT) this.reject(turn, params.itemId);
    return denied;
  }

  /** "No, and tell Codex what to do differently": the call ends rejected, the turn Stopped. */
  private reject(turn: Turn, itemId: string): void {
    this.translator.rejectTool(itemId);
    turn.aborted = true;
  }

  private async askQuestions(params: ToolRequestUserInputParams): Promise<unknown> {
    const answers: Record<string, { answers: string[] }> = {};
    for (const q of params.questions ?? []) {
      if (!this.canAsk()) break;
      const title = [q.header, q.question].filter(Boolean).join(": ") || "Codex asks";
      const options = (q.options ?? []).map((o) => o.label).filter(Boolean);
      const request: UiRequest = options.length && !q.isOther ? { id: this.nextUiId(), kind: "select", title, options } : { id: this.nextUiId(), kind: "input", title };
      const response = await this.ask(request);
      if (!response || !("value" in response)) break;
      answers[q.id] = { answers: [response.value] };
    }
    return { answers };
  }

  private async callTool(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const tool = this.tools.find((t) => t.spec.name === params.tool) ?? this.options.gladeTools?.().find((t) => t.spec.name === params.tool);
    if (!tool) return { contentItems: [{ type: "inputText", text: `Unknown tool: ${params.tool}` }], success: false };
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    try {
      const result = await tool.run(args);
      return { contentItems: [{ type: "inputText", text: result.text }], success: !result.isError };
    } catch (err) {
      return { contentItems: [{ type: "inputText", text: `Error: ${(err as Error).message}` }], success: false };
    }
  }

  private async askPermission(card: { title: string; message?: string; toolCallId?: string; options: PermissionOption[] }): Promise<string | null> {
    const response = await this.ask({ id: this.nextUiId(), kind: "permission", numbered: true, ...card });
    return response && "value" in response ? response.value : null;
  }

  private ask(request: UiRequest): Promise<UiResponse | null> {
    return new Promise((resolve) => {
      this.pendingUi.set(request.id, { resolve });
      this.emit({ type: "ui_request", request });
    });
  }

  private nextUiId(): string {
    return `codex-${(this.ref ?? "new").slice(-8)}-${++this.uiSeq}`;
  }

  private cancelUi(): void {
    for (const [id, pending] of [...this.pendingUi]) {
      this.pendingUi.delete(id);
      pending.resolve(null);
      this.emit({ type: "ui_request_closed", id });
    }
  }

  // Events --------------------------------------------------------------------------------------

  private setState(partial: Partial<SessionState>): void {
    this.emit({ type: "state", state: partial });
  }

  private emit(event: AgentEvent): void {
    if (event.type === "state") this.state = { ...this.state, ...event.state };
    this.transcript = applyAgentEvent(this.transcript, event);
    this.events.emit(event);
  }
}

/** The prompt as Codex input: text, then images as data URLs. */
export function userInput(request: PromptRequest): UserInput[] {
  const input: UserInput[] = [];
  if (request.text || !request.images?.length) input.push({ type: "text", text: request.text, text_elements: [] });
  for (const image of request.images ?? []) input.push({ type: "image", url: `data:${image.mimeType};base64,${image.data}` });
  return input;
}

/** Codex doesn't have (or no longer has loaded) this thread. */
export function isMissingThread(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /no rollout found|thread not found|unknown thread|not loaded|no such thread|thread .* not found/i.test(message);
}
