/**
 * One Glade chat with Claude Code (I-173), on the Claude Agent SDK with streaming input: one
 * Claude Code process per live session, started lazily with the first prompt (viewing a chat
 * never starts it), fed user messages through a {@link PushQueue}.
 *
 * - **Resume:** the session ref *is* Claude's session id (a UUID Glade picks, `sessionId` for a
 *   new session). A later process resumes it (`resume`) when Claude Code has it on disk; the
 *   conversation itself is Glade's (the store, I-121), Claude's copy is only its context.
 * - **Turns:** `run_start` with the prompt, `run_end` after the turn's `result` (unless more queued
 *   turns follow). A message sent while running steers: it goes to Claude Code right away, which
 *   folds it in between tool rounds. A follow-up (⌘↩) waits for the run to end; like pi and ACP it
 *   stays queued when the run is stopped or fails.
 * - **Stop:** `interrupt()`; after a grace period without a result the process is dropped.
 * - **Permissions:** Claude Code's own settings decide; whatever it would ask about comes through
 *   `canUseTool` as a `permission` card (allow once / always / reject). `AskUserQuestion` asks each
 *   question as a `select` dialog.
 * - **Model / thinking:** applied when the next process starts (a live one is restarted when idle).
 * - **Compaction:** `/compact` sent as a message; the `compact_boundary` gives the numbers.
 * - A process that ends by itself (crash, killed) ends the running turn with the error and exits
 *   the session (`onExit`), like pi and ACP; the next prompt starts a new process that resumes.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import {
  applyAgentEvent,
  clampThinkingLevel,
  defaultSessionState,
  emptyTranscript,
  type AgentEvent,
  type CompactResult,
  type ModelRef,
  type PromptRequest,
  type SessionState,
  type SlashCommand,
  type ThinkingLevel,
  type Transcript,
  type UiRequest,
  type UiResponse,
} from "@glade/protocol";
import { compactionNoticeText } from "../format.js";
import { SessionEvents } from "../session-events.js";
import type { HarnessSession } from "../types.js";
import { claudeToolAllowlist } from "./glade-tools.js";
import { CLAUDE_PROVIDER, DEFAULT_CONTEXT_WINDOW, claudeModelId, claudeThinkingLevels, findClaudeModel, thinkingOptions } from "./models.js";
import { PushQueue } from "./push-queue.js";
import type { CanUseTool, ClaudeMcpToolSpec, ClaudeModelInfo, ClaudeOptions, ClaudeQuery, ClaudeSdk, ClaudeSlashCommand, ClaudeUserInput, ClaudeWire, PermissionResult } from "./sdk.js";
import { claudeToolSummary } from "./tools.js";
import { ClaudeTranslator, type TurnEnd } from "./translate.js";

const COMPACT_TIMEOUT_MS = 5 * 60_000;
const LABEL = "Claude Code";

export interface ClaudeSessionOptions {
  sdk: ClaudeSdk;
  /** Full path of the `claude` executable, `null` when it isn't installed. */
  executable: () => string | null;
  cwd: string;
  /** Claude's session id (the chat's session ref). */
  sessionRef: string;
  /** Claude Code may already have this session on disk (a chat reopened): resume it if so. */
  existing: boolean;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
  appendSystemPrompt?: string;
  /** Tool allowlist (pi names, sub-agent definitions). */
  tools?: string[];
  /** Environment of the Claude Code process. */
  env: NodeJS.ProcessEnv;
  /** Glade's own tools for this session (in-process MCP server), read when a process starts. */
  gladeTools?: () => ClaudeMcpToolSpec[];
  /** Claude Code's models (the harness's cache). */
  models: () => Promise<ClaudeModelInfo[]>;
  /** Commands in the chat's folder (the harness's cache), until a process runs. */
  folderCommands: () => Promise<SlashCommand[]>;
  /** How long to wait for a stopped turn's result before dropping the process. */
  cancelGraceMs?: number;
  /** Append every SDK message to this JSONL file (debugging: `GLADE_CLAUDE_TRACE`). */
  traceFile?: string;
  /** Test/dev limits passed to every process (`maxBudgetUsd`, `maxTurns`). */
  limits?: Pick<ClaudeOptions, "maxBudgetUsd" | "maxTurns">;
  log?: (msg: string) => void;
}

interface Turn {
  aborted: boolean;
  done: boolean;
  /** A `/compact` turn: silent (no run events), answered through `resolve`. */
  compact?: { resolve: (result: CompactResult) => void; reject: (err: Error) => void; before: number | null; after: number | null };
}

interface PendingUi {
  request: UiRequest;
  resolve: (response: UiResponse | null) => void;
}

export class ClaudeSession implements HarnessSession {
  readonly sessionRef: string;
  private readonly events: SessionEvents;
  private state: SessionState;
  private transcript: Transcript = emptyTranscript();
  private readonly translator: ClaudeTranslator;
  private query: ClaudeQuery | null = null;
  private input: PushQueue<ClaudeUserInput> | null = null;
  private starting: Promise<ClaudeQuery> | null = null;
  /** Claude Code may have this session on disk (checked before resuming). */
  private existing: boolean;
  /** A process of ours started this session (Claude Code has it: resume without checking). */
  private confirmed = false;
  private turn: Turn | null = null;
  private readonly queue: PromptRequest[] = [];
  private readonly pendingUi = new Map<string, PendingUi>();
  private uiSeq = 0;
  private disposed = false;
  private restartPending = false;
  private cancelTimer: NodeJS.Timeout | null = null;
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
  private stderr = "";
  private commands: SlashCommand[] | null = null;
  /** Steering messages sent while the process was still starting. */
  private readonly pendingSends: PromptRequest[] = [];

  constructor(private readonly options: ClaudeSessionOptions) {
    this.sessionRef = options.sessionRef;
    this.existing = options.existing;
    this.events = new SessionEvents(options.log);
    const model = claudeModelId(options.model) ? options.model : null;
    this.state = { ...defaultSessionState(), model, thinkingLevel: options.thinkingLevel ?? "off", thinkingLevels: claudeThinkingLevels(undefined) };
    this.translator = new ClaudeTranslator(`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`);
  }

  /** Thinking levels of the chosen model, once the model list is known. */
  async init(): Promise<void> {
    const models = await this.options.models().catch(() => [] as ClaudeModelInfo[]);
    const info = findClaudeModel(models, claudeModelId(this.state.model));
    const thinkingLevels = claudeThinkingLevels(info);
    this.setState({ thinkingLevels, thinkingLevel: clampThinkingLevel(thinkingLevels, this.state.thinkingLevel) });
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
    if (turn && !turn.compact) {
      if (request.behavior === "followUp") {
        this.queue.push(request);
        this.emitQueue();
        return;
      }
      // Steer: Claude Code takes it in between tool rounds (or right after this turn).
      for (const event of this.translator.userMessage(request.text, request.images)) this.emit(event);
      this.send(request);
      return;
    }
    if (turn?.compact) throw new Error("Wait for the compaction to finish");
    void this.runTurn(request);
  }

  async abort(): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.done) return;
    turn.aborted = true;
    this.cancelUi();
    const query = this.query;
    if (!query) return; // still starting: runTurn stops before sending
    void query.interrupt().catch((err: Error) => this.options.log?.(`claude: interrupt failed: ${err.message}`));
    this.cancelTimer = setTimeout(() => {
      // No result after the interrupt: drop the process (the next prompt resumes in a new one).
      this.closeQuery();
      this.finishTurn(turn, { stopReason: "aborted" });
    }, this.options.cancelGraceMs ?? 10_000);
    this.cancelTimer.unref?.();
  }

  async setModel(model: ModelRef): Promise<void> {
    if (model.provider !== CLAUDE_PROVIDER || !claudeModelId(model)) throw new Error(`${LABEL} can't use ${model.provider}/${model.id}`);
    const models = await this.options.models().catch(() => [] as ClaudeModelInfo[]);
    const thinkingLevels = claudeThinkingLevels(findClaudeModel(models, model.id));
    this.setState({ model, thinkingLevels, thinkingLevel: clampThinkingLevel(thinkingLevels, this.state.thinkingLevel) });
    this.restartSoon();
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const clamped = clampThinkingLevel(this.state.thinkingLevels, level);
    this.setState({ thinkingLevel: clamped });
    this.restartSoon();
  }

  /** Glade keeps the title; Claude Code's own session title isn't used. */
  async setTitle(_title: string): Promise<void> {}

  respondToUi(response: UiResponse): void {
    const pending = this.pendingUi.get(response.id);
    if (!pending) return;
    this.pendingUi.delete(response.id);
    pending.resolve(response);
  }

  async listCommands(): Promise<SlashCommand[]> {
    if (this.commands) return this.commands;
    const query = this.query;
    if (query) {
      const commands = (await query.supportedCommands()).map(toSlashCommand);
      this.commands = commands;
      return commands;
    }
    return this.options.folderCommands();
  }

  async compact(instructions?: string): Promise<CompactResult> {
    if (this.turn) throw new Error("Wait for the current reply to finish before compacting");
    const turn: Turn = { aborted: false, done: false };
    this.turn = turn;
    const result = new Promise<CompactResult>((resolve, reject) => {
      turn.compact = { resolve, reject, before: null, after: null };
    });
    try {
      await this.ensureQuery();
    } catch (err) {
      this.turn = null;
      throw err;
    }
    this.setState({ isCompacting: true });
    this.send({ text: instructions ? `/compact ${instructions}` : "/compact" });
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
    this.closeQuery();
  }

  // Turns ---------------------------------------------------------------------------------------

  private async runTurn(request: PromptRequest): Promise<void> {
    const turn: Turn = { aborted: false, done: false };
    this.startRun(turn);
    for (const event of this.translator.userMessage(request.text, request.images)) this.emit(event);
    try {
      await this.ensureQuery();
    } catch (err) {
      return this.finishTurn(turn, { stopReason: "error", errorMessage: (err as Error).message });
    }
    if (turn.aborted || turn.done) return this.finishTurn(turn, { stopReason: "aborted" });
    this.send(request);
    for (const pending of this.pendingSends.splice(0)) this.send(pending);
  }

  private startRun(turn: Turn): void {
    this.turn = turn;
    this.emit({ type: "run_start" });
    this.emit({ type: "state", state: { isRunning: true } });
  }

  private send(request: PromptRequest): void {
    const content: Array<Record<string, unknown>> = [];
    if (request.text) content.push({ type: "text", text: request.text });
    for (const image of request.images ?? []) {
      content.push({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } });
    }
    if (!content.length) content.push({ type: "text", text: "" });
    if (!this.input) {
      this.pendingSends.push(request);
      return;
    }
    this.input.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
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
      if (end.stopReason === "stop") {
        const before = turn.compact.before;
        turn.compact.resolve({ tokensBefore: before ?? 0, tokensAfter: turn.compact.after });
      } else {
        turn.compact.reject(new Error(end.errorMessage ?? "Compaction was stopped"));
      }
      for (const event of this.translator.finish({ stopReason: "stop" })) this.emit(event);
    } else {
      for (const event of this.translator.finish(end)) this.emit(event);
      this.emit({ type: "state", state: { isRunning: false } });
      this.emit({ type: "run_end" });
    }
    if (this.restartPending) {
      this.restartPending = false;
      this.closeQuery();
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

  /** Apply model/thinking changes: now when idle, else when the turn ends. */
  private restartSoon(): void {
    if (!this.query) return;
    if (this.turn) this.restartPending = true;
    else this.closeQuery();
  }

  // Process -------------------------------------------------------------------------------------

  private ensureQuery(): Promise<ClaudeQuery> {
    if (this.query) return Promise.resolve(this.query);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<ClaudeQuery> {
    const { sdk, cwd } = this.options;
    const executable = this.options.executable();
    if (!executable) throw new Error(`${LABEL} isn't installed: \`claude\` wasn't found on this device's PATH.`);
    const resume = this.confirmed || (this.existing && (await sdk.hasSession(this.sessionRef, cwd).catch(() => false)));
    const models = await this.options.models().catch(() => [] as ClaudeModelInfo[]);
    const modelId = claudeModelId(this.state.model);
    const gladeTools = this.options.gladeTools?.() ?? [];
    const mcpServers = gladeTools.length ? { glade: await sdk.mcpServer("glade", gladeTools) } : undefined;
    const canUseTool: CanUseTool = (toolName, input, opts) => this.onCanUseTool(toolName, input, opts);
    const options: ClaudeOptions = {
      cwd,
      pathToClaudeCodeExecutable: executable,
      env: { ...this.options.env, CLAUDE_AGENT_SDK_CLIENT_APP: "glade" },
      includePartialMessages: true,
      ...(resume ? { resume: this.sessionRef } : { sessionId: this.sessionRef }),
      ...(modelId ? { model: modelId } : {}),
      ...thinkingOptions(this.state.thinkingLevel, findClaudeModel(models, modelId)),
      systemPrompt: { type: "preset", preset: "claude_code", ...(this.options.appendSystemPrompt ? { append: this.options.appendSystemPrompt } : {}) },
      canUseTool,
      ...(mcpServers ? { mcpServers } : {}),
      ...(this.options.tools?.length ? { tools: claudeToolAllowlist(this.options.tools) } : {}),
      ...this.options.limits,
      stderr: (data) => {
        this.stderr = (this.stderr + data).slice(-2000);
      },
    };
    if (this.existing && !resume) {
      // Glade has the chat but Claude Code doesn't (never prompted, or its file was removed).
      this.options.log?.(`claude ${this.sessionRef}: no saved Claude session; starting it fresh`);
    }
    const input = new PushQueue<ClaudeUserInput>();
    const query = await sdk.query({ prompt: input, options });
    if (this.disposed) {
      input.close();
      query.close();
      throw new Error("The session is closed");
    }
    this.input = input;
    this.query = query;
    this.existing = true;
    void this.pump(query);
    return query;
  }

  private async pump(query: ClaudeQuery): Promise<void> {
    let error: Error | null = null;
    try {
      for await (const message of query) {
        if (this.query !== query) break;
        this.onMessage(message);
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }
    this.onQueryEnd(query, error);
  }

  private onQueryEnd(query: ClaudeQuery, error: Error | null): void {
    if (this.query !== query) return; // closed on purpose (restart, dispose)
    this.query = null;
    this.input?.close();
    this.input = null;
    this.commands = null;
    if (this.disposed) return;
    const stderr = this.stderr.trim();
    const message = error ? `${LABEL} stopped: ${error.message}${stderr && !error.message.includes(stderr) ? `\n${stderr}` : ""}` : `${LABEL} exited unexpectedly${stderr ? `: ${stderr}` : ""}`;
    const turn = this.turn;
    if (turn && !turn.done) this.finishTurn(turn, { stopReason: "error", errorMessage: message });
    this.events.exit(new Error(message));
  }

  private closeQuery(): void {
    const query = this.query;
    this.query = null;
    this.commands = null;
    this.input?.close();
    this.input = null;
    try {
      query?.close();
    } catch (err) {
      this.options.log?.(`claude: close failed: ${(err as Error).message}`);
    }
  }

  // Messages ------------------------------------------------------------------------------------

  private onMessage(message: ClaudeWire): void {
    if (this.disposed) return;
    if (this.options.traceFile) {
      try {
        appendFileSync(this.options.traceFile, `${JSON.stringify({ at: Date.now(), session: this.sessionRef, message })}\n`);
      } catch {
        // tracing is best effort
      }
    }
    switch (message.type) {
      case "system":
        return this.onSystem(message);
      case "result":
        return this.onResult(message);
      case "stream_event":
      case "assistant":
      case "user": {
        if (message.parent_tool_use_id) return;
        if (!this.turn) this.startRun({ aborted: false, done: false }); // a turn Claude Code started itself
        if (this.turn?.compact) return;
        if (message.type === "assistant") this.onUsage(message);
        for (const event of this.translator.message(message)) this.emit(event);
        return;
      }
      case "auth_status":
        if (typeof message.error === "string") this.emit({ type: "notify", level: "error", message: message.error });
        return;
    }
  }

  private onSystem(message: ClaudeWire): void {
    switch (message.subtype) {
      case "init": {
        this.confirmed = true;
        const model = typeof message.model === "string" ? message.model : null;
        if (!this.state.model && model) void this.adoptModel(model);
        return;
      }
      case "status": {
        if (message.status === "compacting") this.setState({ isCompacting: true });
        else if (this.state.isCompacting && !this.turn?.compact) this.setState({ isCompacting: false });
        if (message.compact_result === "failed" && this.turn?.compact) {
          this.finishTurn(this.turn, { stopReason: "error", errorMessage: typeof message.compact_error === "string" ? message.compact_error : "Compaction failed" });
        }
        return;
      }
      case "compact_boundary": {
        const meta = (message.compact_metadata ?? {}) as Record<string, unknown>;
        const before = typeof meta.pre_tokens === "number" ? meta.pre_tokens : null;
        const after = typeof meta.post_tokens === "number" ? meta.post_tokens : null;
        if (this.turn?.compact) {
          this.turn.compact.before = before;
          this.turn.compact.after = after;
        }
        for (const event of this.translator.notice("compaction", compactionNoticeText(before, after))) this.emit(event);
        this.setState({ contextUsage: { tokens: after, contextWindow: this.contextWindow, percent: after !== null ? (after / this.contextWindow) * 100 : null } });
        return;
      }
      case "local_command_output":
        if (typeof message.content === "string" && message.content.trim()) {
          for (const event of this.translator.notice("info", message.content.trim())) this.emit(event);
        }
        return;
      case "notification":
        if (typeof message.text === "string") this.emit({ type: "notify", level: "info", message: message.text });
        return;
      case "informational":
        if (message.level === "warning" && typeof message.content === "string") this.emit({ type: "notify", level: "warning", message: message.content });
        return;
      case "commands_changed":
        if (Array.isArray(message.commands)) this.commands = (message.commands as ClaudeSlashCommand[]).map(toSlashCommand);
        return;
    }
  }

  /** The model Claude Code started with when the chat has none: shown in the picker. */
  private async adoptModel(model: string): Promise<void> {
    const models = await this.options.models().catch(() => [] as ClaudeModelInfo[]);
    if (this.state.model) return;
    const info = findClaudeModel(models, model);
    const thinkingLevels = claudeThinkingLevels(info);
    this.setState({
      model: { provider: CLAUDE_PROVIDER, id: info?.value ?? model },
      thinkingLevels,
      thinkingLevel: clampThinkingLevel(thinkingLevels, this.state.thinkingLevel),
    });
  }

  /** Context usage after each top-level model response. */
  private onUsage(message: ClaudeWire): void {
    const reported = message.context_usage as { total_tokens?: unknown; raw_max_tokens?: unknown; percentage?: unknown } | undefined;
    if (reported && typeof reported.total_tokens === "number" && typeof reported.raw_max_tokens === "number" && reported.raw_max_tokens > 0) {
      this.contextWindow = reported.raw_max_tokens;
      const percent = typeof reported.percentage === "number" ? reported.percentage : (reported.total_tokens / reported.raw_max_tokens) * 100;
      this.setState({ contextUsage: { tokens: reported.total_tokens, contextWindow: reported.raw_max_tokens, percent } });
      return;
    }
    const usage = (message.message as { usage?: Record<string, unknown> } | undefined)?.usage;
    if (!usage) return;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const tokens = n(usage.input_tokens) + n(usage.cache_read_input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.output_tokens);
    if (!tokens) return;
    this.setState({ contextUsage: { tokens, contextWindow: this.contextWindow, percent: (tokens / this.contextWindow) * 100 } });
  }

  private onResult(message: ClaudeWire): void {
    this.onResultStats(message);
    const turn = this.turn;
    if (!turn) return;
    const queued = typeof message.queued_turn_count === "number" ? message.queued_turn_count : 0;
    if (queued > 0 && !turn.aborted && !turn.compact) return; // more turns follow (steered messages)
    this.finishTurn(turn, turn.aborted ? { stopReason: "aborted" } : resultEnd(message));
  }

  private onResultStats(message: ClaudeWire): void {
    const usage = (message.modelUsage ?? {}) as Record<string, Record<string, unknown>>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let window = 0;
    for (const entry of Object.values(usage)) {
      tokens.input += n(entry.inputTokens);
      tokens.output += n(entry.outputTokens);
      tokens.cacheRead += n(entry.cacheReadInputTokens);
      tokens.cacheWrite += n(entry.cacheCreationInputTokens);
      window = Math.max(window, n(entry.contextWindow));
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    const state: Partial<SessionState> = {};
    if (tokens.total > 0 || typeof message.total_cost_usd === "number") state.sessionStats = { tokens, cost: n(message.total_cost_usd) };
    if (window > 0 && window !== this.contextWindow) {
      this.contextWindow = window;
      const usageNow = this.state.contextUsage;
      if (usageNow) state.contextUsage = { ...usageNow, contextWindow: window, percent: usageNow.tokens !== null ? (usageNow.tokens / window) * 100 : null };
    }
    if (Object.keys(state).length) this.setState(state);
  }

  // Permissions and questions -----------------------------------------------------------------

  private async onCanUseTool(toolName: string, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const turn = this.turn;
    if (this.disposed || !turn || turn.aborted || turn.done) return { behavior: "deny", message: "The run was stopped.", interrupt: true };
    if (toolName === "AskUserQuestion") return this.askQuestions(input, opts.signal);
    for (const event of this.translator.ensureTool(opts.toolUseID, toolName, input)) this.emit(event);
    const summary = claudeToolSummary(toolName, input) ?? opts.description ?? opts.blockedPath;
    const request: UiRequest = {
      id: this.nextUiId(),
      kind: "permission",
      title: opts.title || `Allow ${opts.displayName || toolName}?`,
      ...(summary ? { message: summary } : {}),
      toolCallId: opts.toolUseID,
      options: [
        { id: "allow", label: "Allow", kind: "allow_once" },
        ...(opts.suggestions?.length && !opts.suppressAlwaysAllowRule ? [{ id: "allow_always", label: "Always allow", kind: "allow_always" as const }] : []),
        { id: "reject", label: "Reject", kind: "reject_once" },
      ],
    };
    const response = await this.ask(request, opts.signal);
    const value = response && "value" in response ? response.value : null;
    if (value === "allow") return { behavior: "allow", updatedInput: input };
    if (value === "allow_always") return { behavior: "allow", updatedInput: input, updatedPermissions: opts.suggestions ?? [] };
    if (value === "reject") {
      this.translator.rejectTool(opts.toolUseID);
      return { behavior: "deny", message: "The user rejected this tool call." };
    }
    return { behavior: "deny", message: "The run was stopped.", interrupt: true };
  }

  /** `AskUserQuestion`: each question as a `select` dialog; the answers go back as its input. */
  private async askQuestions(input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    const questions = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
    const answers: Record<string, string> = {};
    for (const q of questions) {
      const question = typeof q.question === "string" ? q.question : "Question";
      const options = Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>).map((o) => String(o.label ?? "")).filter(Boolean) : [];
      const response = await this.ask({ id: this.nextUiId(), kind: "select", title: question, options }, signal);
      if (!response || !("value" in response)) return { behavior: "deny", message: "The user didn't answer.", interrupt: true };
      answers[question] = response.value;
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  private ask(request: UiRequest, signal: AbortSignal): Promise<UiResponse | null> {
    return new Promise((resolve) => {
      const done = (response: UiResponse | null) => {
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      };
      const onAbort = () => {
        if (!this.pendingUi.delete(request.id)) return;
        this.emit({ type: "ui_request_closed", id: request.id });
        resolve(null);
      };
      if (signal.aborted) return resolve(null);
      signal.addEventListener("abort", onAbort);
      this.pendingUi.set(request.id, { request, resolve: done });
      this.emit({ type: "ui_request", request });
    });
  }

  private nextUiId(): string {
    return `claude-${this.sessionRef.slice(0, 8)}-${++this.uiSeq}`;
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

/** A new Claude session id (the chat's session ref). */
export function newClaudeSessionId(): string {
  return randomUUID();
}

export function toSlashCommand(command: ClaudeSlashCommand): SlashCommand {
  const name = command.name.replace(/^\//, "");
  return { name, ...(command.description ? { description: command.description } : {}), source: "extension", ...(command.argumentHint ? { argsHint: command.argumentHint } : {}) };
}

/** How a turn's `result` ends it. */
export function resultEnd(result: ClaudeWire): TurnEnd {
  const text = typeof result.result === "string" ? result.result.trim() : "";
  const errors = Array.isArray(result.errors) ? (result.errors as unknown[]).filter((e): e is string => typeof e === "string").join("\n") : "";
  switch (result.subtype) {
    case "success":
      return result.is_error ? { stopReason: "error", errorMessage: friendlyError(text || "Claude Code reported an error") } : { stopReason: "stop" };
    case "error_max_turns":
      return { stopReason: "error", errorMessage: "Claude Code stopped: it reached its limit of turns." };
    case "error_max_budget_usd":
      return { stopReason: "error", errorMessage: "Claude Code stopped: it reached its budget limit." };
    default:
      return { stopReason: "error", errorMessage: friendlyError(errors || text || "Claude Code stopped with an error"), ...(errors && text ? { errorDetails: text } : {}) };
  }
}

/** Sign-in failures in Claude Code's words → what to do about it. */
export function friendlyError(text: string): string {
  if (/please run \/login|invalid api key|not logged in|authentication_failed|oauth token/i.test(text)) {
    return "Claude Code isn't logged in. Run `claude` in a terminal and log in (/login), then try again.";
  }
  return text;
}
