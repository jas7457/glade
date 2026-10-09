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
 * - **Permissions (I-174):** Claude Code's own settings decide; whatever it would ask about comes
 *   through `canUseTool` as a `permission` card worded like the CLI's prompt (`permissions.ts`:
 *   Yes / Yes, and don't ask again for … / No, and tell Claude what to do differently).
 *   `AskUserQuestion` asks each question as a `select` dialog. ExitPlanMode (I-189) shows its plan
 *   as the "Proposed plan" card, then the CLI's "Ready to code?" (`planApprovalCard`): a yes
 *   allows it with a `setMode` update (the pill follows), "No, keep planning" stops the turn in
 *   Plan mode with the composer focused.
 * - **Permission modes (I-174):** the chat's mode is in the state (`permissionMode(s)`); a new chat
 *   starts in Claude Code's own default mode, a saved one is passed to each process
 *   (`permissionMode`), changes apply at once (`setPermissionMode`). Every process may bypass
 *   (`allowDangerouslySkipPermissions`) unless Claude Code's settings disable it; what Claude Code
 *   reports (`init`, `status`) wins.
 * - **Model / thinking:** applied when the next process starts (a live one is restarted when idle).
 * - **Compaction:** `/compact` sent as a message; the `compact_boundary` gives the numbers.
 * - A process that ends by itself (crash, killed) ends the running turn with the error and exits
 *   the session (`onExit`), like pi and ACP; the next prompt starts a new process that resumes.
 * - **Claude's own sub-agents (I-188):** the Task/Agent tool's sub-agent is a native sub-agent
 *   (`onNativeSubagent`), keyed by the Task call's id: its messages (`parent_tool_use_id`, full text
 *   with `forwardSubagentText`) go through its own translator; `task_started` names it, and it
 *   ends with the Task call's result (foreground) or `task_notification` (background). Stop ends
 *   the foreground ones with the turn and stops the background ones (`stopTask`).
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
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
import type { HarnessSession, NativeSubagentEvent, SessionAgentDefinition } from "../types.js";
import { GLADE_MCP_SERVER, claudeToolAllowlist } from "./glade-tools.js";
import {
  PERMISSION_ALLOW,
  PERMISSION_ALWAYS,
  PERMISSION_REJECT,
  REJECT_MESSAGE,
  alwaysAllowLabel,
  claudePermissionModeLabel,
  claudePermissionModes,
  claudePermissionOptions,
  isClaudePermissionMode,
  PLAN_KEEP_PLANNING,
  planApprovalCard,
  planApprovalMode,
  suggestedMode,
  type ClaudePermissionSettings,
} from "./permissions.js";
import { CLAUDE_PROVIDER, DEFAULT_CONTEXT_WINDOW, claudeModelId, claudeThinkingLevels, findClaudeModel, thinkingOptions } from "./models.js";
import { PushQueue } from "./push-queue.js";
import type { CanUseTool, ClaudeMcpToolSpec, ClaudeModelInfo, ClaudeOptions, ClaudeQuery, ClaudeSdk, ClaudeSlashCommand, ClaudeUserInput, ClaudeWire, PermissionResult } from "./sdk.js";
import { EXIT_PLAN_TOOL, claudeToolSummary, toolResultContent } from "./tools.js";
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
  /** The chat's saved permission mode (I-174); absent: Claude Code's own default. */
  permissionMode?: string | null;
  /** Claude Code's permission settings for the folder (default mode, bypass disabled). */
  permissionSettings?: () => ClaudePermissionSettings;
  /** Home folder for paths in permission labels (tests). */
  home?: string;
  appendSystemPrompt?: string;
  /** Tool allowlist (pi names, sub-agent definitions). */
  tools?: string[];
  /** The Glade agent definition this sub-agent runs as (I-218): Claude Code's `agents` + `agent`. */
  agentDefinition?: SessionAgentDefinition;
  /** Called with the first `system/init`'s tools and MCP server names (I-218). */
  onTools?: (tools: string[], mcpServers: string[]) => void;
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

/** One of Claude Code's own sub-agents (I-188), keyed by its Task call's id. */
interface ClaudeSubagent {
  translator: ClaudeTranslator;
  /** Claude Code's task id (`task_started`), for `stopTask` and permission requests (`agentID`). */
  taskId: string | null;
  /** Runs in the background: the Task call returns at once, `task_notification` ends it. */
  background: boolean;
  /** Its latest reply text (its report when nothing better comes). */
  lastText: string | null;
  ended: boolean;
}

/** Claude Code's tools that start a sub-agent. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

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
  /** The mode was saved or picked (passed to each process); else Claude Code's default applies. */
  private modeChosen: boolean;
  private bypassDisabled = false;
  /** The chosen model's `supportsAutoMode`. */
  private autoMode = false;
  /** Claude Code's own sub-agents (I-188), by their Task call's id. */
  private readonly subagents = new Map<string, ClaudeSubagent>();
  /** `task_started` details that came before the sub-agent's first message. */
  private readonly taskInfo = new Map<string, { taskId: string; description?: string; subagentType?: string; prompt?: string; background: boolean }>();

  constructor(private readonly options: ClaudeSessionOptions) {
    this.sessionRef = options.sessionRef;
    this.existing = options.existing;
    this.events = new SessionEvents(options.log);
    const model = claudeModelId(options.model) ? options.model : null;
    // I-218: an agent definition's permission mode is the sub-agent's until the user picks another.
    const chosen = isClaudePermissionMode(options.permissionMode) ? options.permissionMode : isClaudePermissionMode(options.agentDefinition?.permissionMode) ? options.agentDefinition.permissionMode : null;
    this.modeChosen = chosen !== null;
    const permissionMode = chosen ?? "default";
    this.state = {
      ...defaultSessionState(),
      model,
      thinkingLevel: options.thinkingLevel ?? "off",
      thinkingLevels: claudeThinkingLevels(undefined),
      permissionMode,
      permissionModes: claudePermissionModes(undefined, { current: permissionMode }),
    };
    this.translator = new ClaudeTranslator(`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`);
  }

  /** Thinking levels and permission modes of the chosen model, once the model list is known. */
  async init(): Promise<void> {
    const models = await this.options.models().catch(() => [] as ClaudeModelInfo[]);
    const info = findClaudeModel(models, claudeModelId(this.state.model));
    const thinkingLevels = claudeThinkingLevels(info);
    let settings: ClaudePermissionSettings = { defaultMode: null, bypassDisabled: false };
    try {
      settings = this.options.permissionSettings?.() ?? settings;
    } catch (err) {
      this.options.log?.(`claude: reading permission settings failed: ${(err as Error).message}`);
    }
    this.bypassDisabled = settings.bypassDisabled;
    // Claude Code's default model: its "default" entry, or the model it resolves to.
    const resolved = info?.value === "default" && info.resolvedModel ? findClaudeModel(models, info.resolvedModel) : undefined;
    this.autoMode = (info?.supportsAutoMode ?? resolved?.supportsAutoMode) === true;
    // A new chat starts in Claude Code's own default mode (never one carried over from elsewhere).
    const mode = this.modeChosen ? this.state.permissionMode! : (settings.defaultMode ?? "default");
    this.setState({ thinkingLevels, thinkingLevel: clampThinkingLevel(thinkingLevels, this.state.thinkingLevel), ...this.modeState(mode) });
  }

  /** `permissionMode` + the modes offered with it (Auto only on models that support it). */
  private modeState(mode: string, autoMode = this.autoMode): Pick<SessionState, "permissionMode" | "permissionModes"> {
    const modes = claudePermissionModes({ supportsAutoMode: autoMode }, { bypassDisabled: this.bypassDisabled, current: mode });
    return { permissionMode: modes.some((m) => m.id === mode) ? mode : "default", permissionModes: modes };
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
    this.stopBackgroundSubagents();
    const turn = this.turn;
    if (!turn || turn.done) return;
    turn.aborted = true;
    this.translator.stop();
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
    const info = findClaudeModel(models, model.id);
    const thinkingLevels = claudeThinkingLevels(info);
    this.autoMode = info?.supportsAutoMode === true;
    const modes = this.modeState(this.state.permissionMode ?? "default");
    if (modes.permissionMode !== this.state.permissionMode) this.modeChosen = true; // Auto left behind: Default from now on
    this.setState({ model, thinkingLevels, thinkingLevel: clampThinkingLevel(thinkingLevels, this.state.thinkingLevel), ...modes });
    this.restartSoon();
  }

  /**
   * Switch the permission mode (I-174): at once in a running process (`setPermissionMode`), else
   * with the next one. A mode Claude Code refuses (e.g. bypass disabled by its settings) keeps the
   * previous one and rejects.
   */
  async setPermissionMode(mode: string): Promise<void> {
    if (!isClaudePermissionMode(mode) || !(this.state.permissionModes ?? []).some((m) => m.id === mode)) {
      throw new Error(`${LABEL} can't switch to "${mode}" here`);
    }
    const query = this.query ?? (this.starting ? await this.starting.catch(() => null) : null);
    if (query && this.query === query) {
      try {
        await query.setPermissionMode(mode);
      } catch (err) {
        throw new Error(`${LABEL} didn't switch to ${claudePermissionModeLabel(mode)}: ${(err as Error).message}`);
      }
    }
    this.modeChosen = true;
    if (this.state.permissionMode !== mode) this.setState(this.modeState(mode));
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

  onNativeSubagent(listener: (event: NativeSubagentEvent) => void): () => void {
    return this.events.onNativeSubagent(listener);
  }

  /** Stop one sub-agent (its task); `task_notification` (stopped) ends it. */
  async stopNativeSubagent(id: string): Promise<void> {
    const sub = this.subagents.get(id);
    if (!sub || sub.ended) return;
    if (!sub.taskId || !this.query?.stopTask) throw new Error(`${LABEL} can't stop this sub-agent on its own; stop the chat instead`);
    await this.query.stopTask(sub.taskId);
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
      // Foreground sub-agents belong to the turn (their Task call blocks it).
      for (const [id, sub] of this.subagents) {
        if (sub.ended || sub.background) continue;
        const stopped = turn.aborted || end.stopReason === "aborted";
        this.endSubagent(id, stopped ? "stopped" : end.stopReason === "error" ? "error" : "done", stopped ? "Stopped" : end.stopReason === "error" ? end.errorMessage : undefined);
      }
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
    // I-218: run as the agent definition (its prompt replaces Claude Code's; the role prompt is appended).
    const agent = claudeAgentOptions(this.options.agentDefinition, gladeTools.map((t) => t.name), cwd);
    const append = agent.agent ? this.options.agentDefinition!.rolePrompt : this.options.appendSystemPrompt;
    // `tools` = Claude Code's built-in set; MCP tools are restricted by the agent's own list.
    const baseTools = this.options.tools?.length ? claudeToolAllowlist(this.options.tools).filter((t) => !t.startsWith("mcp__")) : [];
    const options: ClaudeOptions = {
      cwd,
      pathToClaudeCodeExecutable: executable,
      env: { ...this.options.env, CLAUDE_AGENT_SDK_CLIENT_APP: "glade" },
      includePartialMessages: true,
      // I-188: the sub-agents' text and thinking too, for their own tabs.
      forwardSubagentText: true,
      ...(resume ? { resume: this.sessionRef } : { sessionId: this.sessionRef }),
      ...(modelId ? { model: modelId } : {}),
      ...thinkingOptions(this.state.thinkingLevel, findClaudeModel(models, modelId)),
      systemPrompt: { type: "preset", preset: "claude_code", ...(append ? { append } : {}) },
      canUseTool,
      // I-174: a saved/picked mode is passed; otherwise Claude Code starts in its own default.
      ...(this.modeChosen && isClaudePermissionMode(this.state.permissionMode) ? { permissionMode: this.state.permissionMode } : {}),
      // Bypass stays selectable mid-run unless Claude Code's settings turn it off.
      ...(this.bypassDisabled ? {} : { allowDangerouslySkipPermissions: true }),
      // Glade's own tools (report_done, message_agent, spawn_agent, chat tools) never ask: they act
      // on Glade, not on the machine, and pi/Codex run them without a permission card too.
      ...(mcpServers ? { mcpServers, allowedTools: [`mcp__${GLADE_MCP_SERVER}`] } : {}),
      ...(baseTools.length ? { tools: baseTools } : {}),
      ...agent,
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
        if (typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id) return this.onSubagentMessage(message.parent_tool_use_id, message);
        if (!this.turn) this.startRun({ aborted: false, done: false }); // a turn Claude Code started itself
        if (this.turn?.compact) return;
        if (message.type === "assistant") this.onUsage(message);
        for (const event of this.translator.message(message)) this.emit(event);
        if (message.type === "assistant") this.startSubagentsOf(message);
        if (message.type === "user") this.onSubagentResults(message);
        return;
      }
      case "auth_status":
        if (typeof message.error === "string") this.emit({ type: "notify", level: "error", message: message.error });
        return;
    }
  }

  /** The first init's tools and MCP servers (I-218: the agent editor's tool picker). */
  private toolsReported = false;
  private reportTools(message: ClaudeWire): void {
    if (this.toolsReported || !this.options.onTools) return;
    this.toolsReported = true;
    const tools = Array.isArray(message.tools) ? message.tools.filter((t): t is string => typeof t === "string") : [];
    const servers = Array.isArray(message.mcp_servers)
      ? message.mcp_servers.map((s) => (s && typeof s === "object" ? (s as { name?: unknown }).name : null)).filter((n): n is string => typeof n === "string")
      : [];
    try {
      this.options.onTools(tools, servers);
    } catch (err) {
      this.options.log?.(`claude: recording tools failed: ${(err as Error).message}`);
    }
  }

  private onSystem(message: ClaudeWire): void {
    switch (message.subtype) {
      case "init": {
        this.confirmed = true;
        this.reportTools(message);
        const model = typeof message.model === "string" ? message.model : null;
        if (!this.state.model && model) void this.adoptModel(model);
        this.adoptMode(message.permissionMode);
        return;
      }
      case "status": {
        this.adoptMode(message.permissionMode);
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
      case "task_started":
        return this.onTaskStarted(message);
      case "task_notification":
        return this.onTaskNotification(message);
    }
  }

  // Claude's own sub-agents (I-188) -----------------------------------------------------------

  /** A Task/Agent call in the main conversation starts a sub-agent (announced once its args are known). */
  private startSubagentsOf(message: ClaudeWire): void {
    const content = (message.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "tool_use" && typeof block.id === "string" && SUBAGENT_TOOLS.has(String(block.name))) this.ensureSubagent(block.id);
    }
  }

  private ensureSubagent(toolUseId: string): ClaudeSubagent {
    const known = this.subagents.get(toolUseId);
    if (known) return known;
    const info = this.taskInfo.get(toolUseId);
    this.taskInfo.delete(toolUseId);
    const args = this.translator.toolCall(toolUseId)?.args ?? {};
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const sub: ClaudeSubagent = {
      translator: new ClaudeTranslator(`${this.sessionRef.slice(0, 8)}-${toolUseId.slice(-8)}`, Date.now, true),
      taskId: info?.taskId ?? null,
      background: info?.background ?? args.run_in_background === true,
      lastText: null,
      ended: false,
    };
    this.subagents.set(toolUseId, sub);
    const model = str(args.model);
    const task = str(args.prompt) ?? info?.prompt ?? "";
    const title = str(args.description) ?? info?.description;
    this.events.native({
      type: "native_subagent_start",
      id: toolUseId,
      toolCallId: toolUseId,
      name: str(args.name) ?? str(args.subagent_type) ?? info?.subagentType ?? "general-purpose",
      task,
      ...(title ? { title } : {}),
      ...(model ? { model: { provider: CLAUDE_PROVIDER, id: model } } : {}),
    });
    return sub;
  }

  private onSubagentMessage(toolUseId: string, message: ClaudeWire): void {
    const sub = this.ensureSubagent(toolUseId);
    if (sub.ended) return;
    for (const event of sub.translator.message(message)) this.emitSubagent(toolUseId, sub, event);
  }

  private emitSubagent(id: string, sub: ClaudeSubagent, event: AgentEvent): void {
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = event.message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n").trim();
      if (text) sub.lastText = text;
    }
    this.events.native({ type: "native_subagent_event", id, event });
  }

  /** `task_started`: a sub-agent's type, description and whether it runs in the background. */
  private onTaskStarted(message: ClaudeWire): void {
    const toolUseId = typeof message.tool_use_id === "string" ? message.tool_use_id : null;
    const taskId = typeof message.task_id === "string" ? message.task_id : null;
    if (!toolUseId || !taskId) return;
    const isAgent = message.task_type === "local_agent" || typeof message.subagent_type === "string" || SUBAGENT_TOOLS.has(this.translator.toolCall(toolUseId)?.name ?? "");
    if (!isAgent) return;
    const background = message.is_backgrounded === true;
    const known = this.subagents.get(toolUseId);
    if (known) {
      known.taskId = taskId;
      known.background ||= background;
      return;
    }
    this.taskInfo.set(toolUseId, {
      taskId,
      background,
      ...(typeof message.description === "string" ? { description: message.description } : {}),
      ...(typeof message.subagent_type === "string" ? { subagentType: message.subagent_type } : {}),
      ...(typeof message.prompt === "string" ? { prompt: message.prompt } : {}),
    });
    this.ensureSubagent(toolUseId);
  }

  /** `task_notification`: a sub-agent finished, failed or was stopped. */
  private onTaskNotification(message: ClaudeWire): void {
    const toolUseId =
      (typeof message.tool_use_id === "string" ? message.tool_use_id : null) ??
      [...this.subagents].find(([, s]) => s.taskId === message.task_id)?.[0] ??
      null;
    const sub = toolUseId ? this.subagents.get(toolUseId) : undefined;
    if (!toolUseId || !sub || sub.ended) return;
    const summary = typeof message.summary === "string" ? message.summary.trim() : "";
    if (message.status === "completed") {
      // A foreground sub-agent's report is its Task call's result (it may come right after).
      if (!sub.background) return;
      this.endSubagent(toolUseId, "done", undefined, summary);
    } else {
      this.endSubagent(toolUseId, message.status === "stopped" ? "stopped" : "error", summary || undefined);
    }
  }

  /** The Task call's result: a foreground sub-agent's report (a background one only launched). */
  private onSubagentResults(message: ClaudeWire): void {
    const content = (message.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    const results = (content as Array<Record<string, unknown>>).filter((b) => b.type === "tool_result" && typeof b.tool_use_id === "string");
    for (const block of results) {
      const id = block.tool_use_id as string;
      const sub = this.subagents.get(id);
      if (!sub || sub.ended) continue;
      const structured = results.length === 1 && message.tool_use_result && typeof message.tool_use_result === "object" ? (message.tool_use_result as Record<string, unknown>) : null;
      if (structured?.status === "async_launched") {
        sub.background = true;
        continue;
      }
      const report = agentReport(structured) ?? toolResultContent(block.content).output.trim();
      this.endSubagent(id, block.is_error ? "error" : "done", report || undefined);
    }
  }

  /** End a sub-agent: `result` as given, else (finished) its last reply, else `fallback`. */
  private endSubagent(id: string, status: "done" | "error" | "stopped", result?: string, fallback?: string): void {
    const sub = this.subagents.get(id);
    if (!sub || sub.ended) return;
    const end: TurnEnd = status === "done" ? { stopReason: "stop" } : status === "stopped" ? { stopReason: "aborted" } : { stopReason: "error", ...(result ? { errorMessage: result } : {}) };
    for (const event of sub.translator.finish(end)) this.emitSubagent(id, sub, event);
    sub.ended = true;
    const text = (result?.trim() || (status === "done" ? sub.lastText : null) || fallback?.trim()) ?? "";
    this.events.native({ type: "native_subagent_end", id, status, ...(text ? { result: text } : {}) });
  }

  /** Stop: background sub-agents outlive the turn, so they're stopped by task id. */
  private stopBackgroundSubagents(): void {
    const query = this.query;
    for (const sub of this.subagents.values()) {
      if (sub.ended || !sub.background || !sub.taskId) continue;
      void query?.stopTask?.(sub.taskId).catch((err: Error) => this.options.log?.(`claude: stopping task ${sub.taskId} failed: ${err.message}`));
    }
  }

  /** The mode Claude Code reports (its default at start, a plan approved, a card's switch): shown in the pill. */
  private adoptMode(mode: unknown): void {
    if (!isClaudePermissionMode(mode) || mode === this.state.permissionMode) return;
    this.setState(this.modeState(mode));
  }

  /** The model Claude Code started with when the chat has none: shown in the picker. */
  private async adoptModel(model: string): Promise<void> {
    const models = await this.options.models().catch(() => [] as ClaudeModelInfo[]);
    if (this.state.model) return;
    const info = findClaudeModel(models, model);
    const thinkingLevels = claudeThinkingLevels(info);
    if (info) this.autoMode = info.supportsAutoMode === true;
    this.setState({
      model: { provider: CLAUDE_PROVIDER, id: info?.value ?? model },
      thinkingLevels,
      thinkingLevel: clampThinkingLevel(thinkingLevels, this.state.thinkingLevel),
      ...this.modeState(this.state.permissionMode ?? "default"),
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
    // A sub-agent's tool (I-188): the call is in its tab; the card asks here.
    const agentId = (opts as { agentID?: string }).agentID;
    const sub = agentId ? [...this.subagents].find(([, s]) => s.taskId === agentId) : undefined;
    if (sub) for (const event of sub[1].translator.ensureTool(opts.toolUseID, toolName, input)) this.emitSubagent(sub[0], sub[1], event);
    else if (!agentId) for (const event of this.translator.ensureTool(opts.toolUseID, toolName, input)) this.emit(event);
    if (toolName === EXIT_PLAN_TOOL && !agentId) return this.approvePlan(turn, input, opts);
    const summary = claudeToolSummary(toolName, input) ?? opts.description ?? opts.blockedPath;
    // I-174: Claude Code's own prompt: Yes / Yes, and don't ask again for … / No, and tell Claude …
    const always = opts.suppressAlwaysAllowRule ? null : alwaysAllowLabel(opts.suggestions, this.options.cwd, this.options.home);
    const request: UiRequest = {
      id: this.nextUiId(),
      kind: "permission",
      title: opts.title || `Allow ${opts.displayName || toolName}?`,
      ...(summary ? { message: summary } : {}),
      toolCallId: opts.toolUseID,
      options: claudePermissionOptions(always),
      numbered: true,
      ...(opts.defaultToNo ? { defaultOptionId: PERMISSION_REJECT } : {}),
    };
    const response = await this.ask(request, opts.signal);
    const value = response && "value" in response ? response.value : null;
    if (value === PERMISSION_ALLOW) return { behavior: "allow", updatedInput: input };
    if (value === PERMISSION_ALWAYS && always) {
      const mode = suggestedMode(opts.suggestions);
      if (mode && mode !== this.state.permissionMode) {
        // "Yes, allow all edits during this session": the pill follows at once.
        this.modeChosen = true;
        this.setState(this.modeState(mode));
      }
      return { behavior: "allow", updatedInput: input, updatedPermissions: opts.suggestions ?? [] };
    }
    if (value === PERMISSION_REJECT) {
      // "No, and tell Claude what to do differently": it stops and waits for the user (the turn
      // ends as stopped, not failed).
      this.translator.rejectTool(opts.toolUseID);
      turn.aborted = true;
      return { behavior: "deny", message: REJECT_MESSAGE, interrupt: true };
    }
    return { behavior: "deny", message: "The run was stopped.", interrupt: true };
  }

  /**
   * ExitPlanMode (I-189): the plan as the "Proposed plan" card, then the CLI's "Ready to code?".
   * A yes allows the call with a `setMode` update (Claude Code leaves Plan mode for that mode; the
   * pill follows now, Claude Code's own report confirms it); "No, keep planning" denies it like the
   * CLI's No (Claude stops and waits) and the turn ends Stopped, still in Plan mode.
   */
  private async approvePlan(turn: Turn, input: Record<string, unknown>, opts: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const plan = planText(input);
    if (plan) for (const event of this.translator.proposePlan(opts.toolUseID, plan)) this.emit(event);
    const card = planApprovalCard(this.autoMode);
    // Opens on the first yes, like the CLI.
    const response = await this.ask({ id: this.nextUiId(), kind: "permission", numbered: true, ...card, defaultOptionId: card.options[0]!.id }, opts.signal);
    const value = response && "value" in response ? response.value : null;
    const mode = planApprovalMode(value);
    if (mode && (mode !== "auto" || this.autoMode)) {
      this.modeChosen = true;
      if (mode !== this.state.permissionMode) this.setState(this.modeState(mode));
      return { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] };
    }
    if (value === PLAN_KEEP_PLANNING) {
      turn.aborted = true;
      return { behavior: "deny", message: REJECT_MESSAGE, interrupt: true };
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

/** ExitPlanMode's plan: its `plan` input, else the plan file it names (`planFilePath`). */
export function planText(input: Record<string, unknown>): string | null {
  if (typeof input.plan === "string" && input.plan.trim()) return input.plan;
  if (typeof input.planFilePath === "string" && input.planFilePath) {
    try {
      return readFileSync(input.planFilePath, "utf8");
    } catch {
      return null;
    }
  }
  return null;
}

/** A completed Task call's structured result (`AgentOutput`): the sub-agent's report text. */
function agentReport(structured: Record<string, unknown> | null): string | null {
  if (!structured || !Array.isArray(structured.content)) return null;
  const text = (structured.content as Array<Record<string, unknown>>)
    .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("\n")
    .trim();
  return text || null;
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

/**
 * Claude Code agent-file fields (I-218: a discovered `.claude/agents/*.md`, or one a Glade agent
 * extends) passed through in the SDK's `AgentDefinition`. Glade handles the rest itself: model and
 * effort (the chat's model/thinking), permission mode (the chat's mode), tools. `hooks` and other
 * keys the SDK's `AgentDefinition` doesn't take are dropped.
 */
export const CLAUDE_AGENT_NATIVE_KEYS = ["mcpServers", "skills", "maxTurns", "memory", "initialPrompt", "criticalSystemReminder_EXPERIMENTAL"] as const;

/**
 * SDK options that run the session as a Glade agent definition (I-218): `agents: { name: def }` +
 * `agent: name`, Claude Code's own way of running a custom agent as the main thread. Its prompt
 * replaces Claude Code's system prompt (as with `claude --agent`), so the folder is named in it;
 * Glade's role prompt still goes in through `systemPrompt.append`, and Glade's MCP tools are added
 * to its tool allowlist. A definition without a prompt keeps Claude Code's prompt: then only its
 * tools apply (through `tools` / `disallowedTools`).
 */
export function claudeAgentOptions(def: SessionAgentDefinition | undefined, gladeTools: readonly string[], cwd: string): Pick<ClaudeOptions, "agent" | "agents" | "disallowedTools"> {
  if (!def) return {};
  const glade = gladeTools.map((name) => `mcp__${GLADE_MCP_SERVER}__${name}`);
  const tools = def.tools?.length ? [...new Set([...claudeToolAllowlist(def.tools), ...glade])] : undefined;
  const disallowed = def.disallowedTools?.length ? def.disallowedTools : undefined;
  if (!def.prompt.trim()) return disallowed ? { disallowedTools: disallowed } : {};
  const native: Record<string, unknown> = {};
  for (const key of CLAUDE_AGENT_NATIVE_KEYS) if (def.native?.claude?.[key] !== undefined) native[key] = def.native.claude[key];
  const definition = {
    ...native,
    description: def.description || def.name,
    prompt: `${def.prompt.trim()}\n\nYou are working in ${cwd}.`,
    ...(tools ? { tools } : {}),
    ...(disallowed ? { disallowedTools: disallowed } : {}),
  } as NonNullable<ClaudeOptions["agents"]>[string];
  return { agents: { [def.name]: definition }, agent: def.name, ...(disallowed ? { disallowedTools: disallowed } : {}) };
}
