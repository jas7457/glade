import { existsSync } from "node:fs";
import { rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  clampThinkingLevel,
  defaultSessionState,
  modelKey,
  type AgentEvent,
  type CompactResult,
  type HarnessDefaults,
  type ModelInfo,
  type ModelRef,
  type PiHarnessSettings,
  type PromptRequest,
  type SessionState,
  type ShellResult,
  type SlashCommand,
  type ThinkingLevel,
  type Transcript,
  type UiResponse,
} from "@glade/protocol";
import { fetchAnthropicUsageLimits } from "../../services/providers/anthropic-usage.js";
import { SessionEvents } from "../session-events.js";
import type { AgentHarness, CompletionRequest, HarnessDescription, HarnessSession, OpenSessionOptions, ShellRunRequest } from "../types.js";
import { readPiAnthropicAuth } from "./anthropic-auth.js";
import { piChildEnv } from "./child-env.js";
import { piOneShot } from "./one-shot.js";
import { PiRpcProcess } from "./rpc-process.js";
import { piSessionReader } from "./session-reader.js";
import { readPiTranscript } from "./transcript-file.js";
import {
  PiEventTranslator,
  translateCommands,
  translateDefaults,
  translateMessages,
  translateModel,
  translateSessionStats,
  translateShellResult,
  translateState,
  type PiModel,
} from "./translate.js";

export interface PiHarnessOptions {
  /** `Settings.harnesses.pi`, resolved lazily so changes apply to newly spawned processes. */
  config: () => PiHarnessSettings;
  /** Folder used for the model-listing utility process. */
  utilityCwd: string;
  log?: (msg: string) => void;
}

export class PiHarness implements AgentHarness {
  readonly id = "pi";
  readonly info: HarnessDescription = {
    label: "pi",
    capabilities: { compact: true, exportHtml: true, steering: true, uiRequests: true, usageLimits: true, commands: true, subagents: true, shell: true },
  };
  /** Claude subscription limits when pi is logged in to Anthropic with OAuth (read-only). */
  getUsageLimits = () => fetchAnthropicUsageLimits({ token: () => readPiAnthropicAuth() });
  /** Search reads pi's session files directly (I-045). */
  statSession = (sessionRef: string) => piSessionReader.stat(sessionRef);
  readSessionText = (sessionRef: string) => piSessionReader.read(sessionRef);
  private modelsCache: { at: number; models: ModelInfo[]; defaults: HarnessDefaults } | null = null;
  private modelsInflight: Promise<ModelInfo[]> | null = null;

  constructor(private readonly options: PiHarnessOptions) {}

  async listModels(force = false): Promise<ModelInfo[]> {
    if (!force && this.modelsCache && Date.now() - this.modelsCache.at < 60_000) return this.modelsCache.models;
    // Concurrent callers share one utility process.
    this.modelsInflight ??= this.fetchModels().finally(() => {
      this.modelsInflight = null;
    });
    return this.modelsInflight;
  }

  /**
   * pi's own default model + thinking level (`~/.pi/agent/settings.json`), as reported by the
   * model-listing utility process's `get_state` (it starts on them). Cached with the models.
   */
  async getDefaults(force = false): Promise<HarnessDefaults> {
    await this.listModels(force);
    return this.modelsCache?.defaults ?? { model: null, thinkingLevel: null };
  }

  private async fetchModels(): Promise<ModelInfo[]> {
    // Extensions stay enabled: they can register providers/models (and handle provider auth).
    const proc = this.spawn(this.options.utilityCwd, ["--no-session", "--no-skills"]);
    try {
      const [data, state] = await Promise.all([
        proc.request<{ models: PiModel[] }>({ type: "get_available_models" }),
        proc.request<Record<string, unknown>>({ type: "get_state" }).catch((err: Error) => {
          this.options.log?.(`get_state (defaults) failed: ${err.message}`);
          return null;
        }),
      ]);
      const models = data.models.map(translateModel);
      this.modelsCache = { at: Date.now(), models, defaults: translateDefaults(state ?? {}) };
      return models;
    } finally {
      void proc.kill();
    }
  }

  /**
   * Commands (extensions, skills, prompt templates) pi loads in `cwd`, via a short-lived utility
   * process there (project `.pi/` skills and prompts depend on the folder). Not cached here.
   */
  async listFolderCommands(cwd: string): Promise<SlashCommand[]> {
    const proc = this.spawn(cwd, ["--no-session"]);
    try {
      const data = await proc.request<Record<string, unknown>>({ type: "get_commands" });
      return translateCommands(data ?? {});
    } catch (err) {
      const stderr = proc.recentStderr;
      throw new Error(`${(err as Error).message}${stderr ? `\n${stderr}` : ""}`);
    } finally {
      void proc.kill();
    }
  }

  async openSession(options: OpenSessionOptions): Promise<HarnessSession> {
    const args: string[] = [];
    if (options.sessionRef) args.push("--session", options.sessionRef);
    if (options.model) args.push("--model", modelKey(options.model));
    if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
    if (options.appendSystemPrompt) args.push("--append-system-prompt", options.appendSystemPrompt);
    if (options.tools?.length) args.push("--tools", options.tools.join(","));
    const proc = this.spawn(options.cwd, args, options.env);
    const session = new PiSession(proc, this.options.log, options.cwd);
    try {
      await session.init(this.options.config());
    } catch (err) {
      void proc.kill();
      const stderr = proc.recentStderr;
      throw new Error(`${(err as Error).message}${stderr ? `\n${stderr}` : ""}`);
    }
    return session;
  }

  async deleteSession(sessionRef: string): Promise<void> {
    // Permanent: the session file is removed, not moved to the Trash.
    await rm(sessionRef, { force: true });
    // Drop pi's per-cwd session folder once it's empty (fails harmlessly otherwise).
    await rmdir(dirname(sessionRef)).catch(() => {});
  }

  readTranscript(sessionRef: string): Promise<Transcript | null> {
    return readPiTranscript(sessionRef);
  }

  /** `pi -p` in the utility folder (or `cwd`); titles build on this (`harness/title.ts`). */
  complete({ prompt, model, cwd, timeoutMs }: CompletionRequest): Promise<string | null> {
    const { piPath } = this.options.config();
    return piOneShot({ piPath, cwd: cwd ?? this.options.utilityCwd, prompt, model, timeoutMs, log: this.options.log });
  }

  async dispose(): Promise<void> {}

  private spawn(cwd: string, args: string[], env?: Record<string, string>): PiRpcProcess {
    const { piPath, extraArgs } = this.options.config();
    const proc = new PiRpcProcess({ command: piPath, args: ["--mode", "rpc", ...args, ...extraArgs], cwd, env: piChildEnv(process.env, env) });
    proc.on("stderr", (text) => this.options.log?.(`[pi ${cwd}] ${text.trimEnd()}`));
    proc.start();
    return proc;
  }
}

/** pi events after which context usage / session totals may have changed. */
const STATS_TRIGGERS = new Set(["turn_end", "agent_settled", "compaction_end"]);

/** Manual compaction summarizes with the model; give it plenty of time. */
const COMPACT_TIMEOUT_MS = 5 * 60_000;

/** Where `/export` writes HTML files: ~/Downloads when it exists (macOS), else the temp dir. */
function defaultExportDir(): string {
  const downloads = join(homedir(), "Downloads");
  return existsSync(downloads) ? downloads : tmpdir();
}

export class PiSession implements HarnessSession {
  private state: SessionState = defaultSessionState();
  private ref: string | null = null;
  private readonly translator = new PiEventTranslator();
  private readonly events: SessionEvents;
  private disposed = false;
  private commands: Promise<SlashCommand[]> | null = null;
  /** `compact` requests in flight (their failures are reported by the request, not as a toast). */
  private manualCompactions = 0;
  /** `get_session_stats` in flight; further requests meanwhile coalesce into one follow-up. */
  private statsInflight = false;
  private statsDirty = false;

  constructor(
    private readonly proc: PiRpcProcess,
    private readonly log?: (msg: string) => void,
    private readonly cwd = process.cwd(),
    /** Folder for `exportHtml` (injectable for tests). */
    private readonly exportDir: () => string = defaultExportDir,
  ) {
    this.events = new SessionEvents(log);
    proc.on("event", (raw) => {
      for (const event of this.translator.translate(raw)) {
        if (event.type === "state") this.state = { ...this.state, ...event.state };
        // A failed manual compaction is reported to its caller (the RPC response); don't toast twice.
        if (event.type === "notify" && raw.type === "compaction_end" && this.manualCompactions > 0) continue;
        this.emit(event);
      }
      if (typeof raw.type === "string" && STATS_TRIGGERS.has(raw.type)) this.refreshStats();
    });
    proc.on("exit", () => {
      const error = this.disposed ? null : new Error(proc.recentStderr || "pi process exited unexpectedly");
      this.events.exit(error);
    });
  }

  get sessionRef(): string | null {
    return this.ref;
  }

  async init(config: { autoCompaction: boolean; autoRetry: boolean }): Promise<void> {
    await this.refreshState();
    await Promise.all([
      this.proc.request({ type: "set_auto_compaction", enabled: config.autoCompaction }),
      this.proc.request({ type: "set_auto_retry", enabled: config.autoRetry }),
      // Part of the initial state, so the context meter is right as soon as the chat opens.
      this.fetchStats().catch((err: Error) => this.log?.(`get_session_stats failed: ${err.message}`)),
    ]);
  }

  /**
   * Refresh `contextUsage`/`sessionStats` in the background. At most one request is in flight;
   * calls made meanwhile coalesce into a single follow-up request.
   */
  refreshStats(): void {
    if (this.disposed) return;
    if (this.statsInflight) {
      this.statsDirty = true;
      return;
    }
    this.statsInflight = true;
    void this.fetchStats()
      .catch((err: Error) => {
        if (!this.disposed) this.log?.(`get_session_stats failed: ${err.message}`);
      })
      .finally(() => {
        this.statsInflight = false;
        if (this.statsDirty) {
          this.statsDirty = false;
          this.refreshStats();
        }
      });
  }

  private async fetchStats(): Promise<void> {
    const data = await this.proc.request<Record<string, unknown>>({ type: "get_session_stats" });
    const stats = translateSessionStats(data ?? {});
    if (stats.contextUsage || stats.sessionStats) this.setState(stats);
  }

  listCommands(): Promise<SlashCommand[]> {
    // Commands come from extensions/skills/prompt files loaded at startup: cache per process.
    this.commands ??= this.proc
      .request<Record<string, unknown>>({ type: "get_commands" })
      .then((data) => translateCommands(data ?? {}))
      .catch((err: Error) => {
        this.commands = null;
        throw err;
      });
    return this.commands;
  }

  async compact(instructions?: string): Promise<CompactResult> {
    const custom = instructions?.trim();
    this.manualCompactions++;
    let data: Record<string, unknown>;
    try {
      data = await this.proc.request<Record<string, unknown>>(
        { type: "compact", ...(custom ? { customInstructions: custom } : {}) },
        COMPACT_TIMEOUT_MS,
      );
    } finally {
      this.manualCompactions--;
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { tokensBefore: num(data?.tokensBefore) ?? 0, tokensAfter: num(data?.estimatedTokensAfter) };
  }

  async exportHtml(): Promise<string> {
    // pi's default is a relative file in the project folder; keep exports out of the repo.
    const name = this.ref ? `pi-session-${basename(this.ref).replace(/\.jsonl$/, "")}.html` : `pi-session-${Date.now()}.html`;
    const data = await this.proc.request<{ path?: unknown }>({ type: "export_html", outputPath: join(this.exportDir(), name) }, 60_000);
    const path = typeof data?.path === "string" ? data.path : join(this.exportDir(), name);
    return isAbsolute(path) ? path : resolve(this.cwd, path);
  }

  /**
   * `!cmd` / `!!cmd` (I-076): pi's RPC `bash` runs it right away in the session's cwd (no model
   * turn) and stores a `bashExecution` message (`excludeFromContext` for `!!`) that reaches the
   * model with the next prompt. Output streams as `bash_execution_update` events carrying our id.
   */
  async runShell({ id, command, shareWithAgent }: ShellRunRequest): Promise<ShellResult> {
    this.emit({ type: "shell_start", id, command, shared: shareWithAgent, at: Date.now() });
    let result: ShellResult;
    try {
      const data = await this.proc.request<Record<string, unknown>>(
        { type: "bash", id, command, excludeFromContext: !shareWithAgent },
        Number.POSITIVE_INFINITY, // runs until it ends or is stopped
      );
      result = translateShellResult(data ?? {});
    } catch (err) {
      result = { output: "", exitCode: null, cancelled: false, truncated: false, error: (err as Error).message };
    }
    this.emit({ type: "shell_end", id, result, at: Date.now() });
    return result;
  }

  async abortShell(): Promise<void> {
    await this.proc.request({ type: "abort_bash" });
  }

  getState(): SessionState {
    return this.state;
  }

  async loadTranscript(): Promise<Transcript> {
    const data = await this.proc.request<{ messages: Array<Record<string, unknown>> }>({ type: "get_messages" });
    const transcript = translateMessages(data.messages, (i) => `h${i}`);
    return transcript;
  }

  async prompt(request: PromptRequest): Promise<void> {
    const images = request.images?.map((img) => ({ type: "image", data: img.data, mimeType: img.mimeType }));
    await this.proc.request({
      type: "prompt",
      message: request.text,
      ...(images?.length ? { images } : {}),
      // pi only reads streamingBehavior while streaming; pass it whenever we have one, since our
      // isRunning lags right after a prompt (e.g. a sub-agent message arriving just after its task).
      ...(this.state.isRunning || request.behavior ? { streamingBehavior: request.behavior ?? "steer" } : {}),
    });
  }

  async abort(): Promise<void> {
    await this.proc.request({ type: "abort" }, 60_000);
  }

  async setModel(model: ModelRef): Promise<void> {
    await this.proc.request({ type: "set_model", provider: model.provider, modelId: model.id });
    await this.refreshState();
    this.refreshStats(); // the context window may have changed
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const clamped = clampThinkingLevel(this.state.thinkingLevels, level);
    await this.proc.request({ type: "set_thinking_level", level: clamped });
    this.setState({ thinkingLevel: clamped });
  }

  async setTitle(title: string): Promise<void> {
    await this.proc.request({ type: "set_session_name", name: title });
  }

  respondToUi(response: UiResponse): void {
    this.proc.write({ type: "extension_ui_response", ...response });
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    return this.events.onEvent(listener);
  }

  onExit(listener: (error: Error | null) => void): () => void {
    return this.events.onExit(listener);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.proc.kill();
  }

  private async refreshState(): Promise<void> {
    const data = await this.proc.request<Record<string, unknown>>({ type: "get_state" });
    if (typeof data.sessionFile === "string") this.ref = data.sessionFile;
    this.setState(translateState(data));
  }

  private setState(partial: Partial<SessionState>): void {
    this.state = { ...this.state, ...partial };
    this.emit({ type: "state", state: partial });
  }

  private emit(event: AgentEvent): void {
    this.events.emit(event);
  }
}
