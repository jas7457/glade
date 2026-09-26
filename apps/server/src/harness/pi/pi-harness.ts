import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  clampThinkingLevel,
  defaultSessionState,
  modelKey,
  type AgentEvent,
  type CompactResult,
  type ModelInfo,
  type ModelRef,
  type PromptRequest,
  type SessionState,
  type SlashCommand,
  type ThinkingLevel,
  type Transcript,
  type UiResponse,
} from "@pi-ui/protocol";
import type { AgentHarness, GenerateTitleOptions, HarnessSession, OpenSessionOptions } from "../types.js";
import { PiRpcProcess } from "./rpc-process.js";
import {
  PiEventTranslator,
  translateCommands,
  translateMessages,
  translateModel,
  translateSessionStats,
  translateState,
  type PiModel,
} from "./translate.js";

const execFileAsync = promisify(execFile);

export interface PiHarnessOptions {
  /** Resolved lazily so settings changes apply to newly spawned processes. */
  config: () => { piPath: string; extraArgs: string[]; autoCompaction: boolean; autoRetry: boolean };
  /** Folder used for the model-listing utility process. */
  utilityCwd: string;
  log?: (msg: string) => void;
}

export class PiHarness implements AgentHarness {
  readonly id = "pi";
  private modelsCache: { at: number; models: ModelInfo[] } | null = null;
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

  private async fetchModels(): Promise<ModelInfo[]> {
    // Extensions stay enabled: they can register providers/models (and handle provider auth).
    const proc = this.spawn(this.options.utilityCwd, ["--no-session", "--no-skills"]);
    try {
      const data = await proc.request<{ models: PiModel[] }>({ type: "get_available_models" });
      const models = data.models.map(translateModel);
      this.modelsCache = { at: Date.now(), models };
      return models;
    } finally {
      void proc.kill();
    }
  }

  async openSession(options: OpenSessionOptions): Promise<HarnessSession> {
    const args: string[] = [];
    if (options.sessionRef) args.push("--session", options.sessionRef);
    if (options.model) args.push("--model", modelKey(options.model));
    if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
    const proc = this.spawn(options.cwd, args);
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

  async generateTitle({ firstMessage, cwd, model }: GenerateTitleOptions): Promise<string | null> {
    const { piPath } = this.options.config();
    const prompt =
      "Write a short title (max 6 words) for a conversation that starts with the message below. " +
      "Reply with the title only: no quotes, no trailing punctuation.\n\n<message>\n" +
      firstMessage.slice(0, 2000) +
      "\n</message>";
    // Not --no-extensions: extensions may provide the provider/auth the model needs (with them
    // disabled, Anthropic subscription auth was rejected in testing).
    const args = ["-p", "--no-session", "--no-tools", "--no-skills", "--no-context-files"];
    if (model) args.push("--model", modelKey(model), "--thinking", "off");
    args.push("--", prompt);
    try {
      const pending = execFileAsync(piPath, args, { cwd, timeout: 45_000, maxBuffer: 1024 * 1024 });
      // `pi -p` reads piped stdin as extra input; close it so it doesn't wait for EOF.
      pending.child.stdin?.end();
      const { stdout } = await pending;
      const title = stdout
        .split("\n")
        .map((l) => l.trim())
        .find(Boolean)
        ?.replace(/^["'#*\s]+|["'*.\s]+$/g, "")
        .slice(0, 80);
      return title || null;
    } catch (err) {
      this.options.log?.(`title generation failed: ${(err as Error).message}`);
      return null;
    }
  }

  async dispose(): Promise<void> {}

  private spawn(cwd: string, args: string[]): PiRpcProcess {
    const { piPath, extraArgs } = this.options.config();
    const proc = new PiRpcProcess({ command: piPath, args: ["--mode", "rpc", ...args, ...extraArgs], cwd });
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
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly exitListeners = new Set<(error: Error | null) => void>();
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
      for (const listener of this.exitListeners) listener(error);
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
      ...(this.state.isRunning ? { streamingBehavior: request.behavior ?? "steer" } : {}),
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
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExit(listener: (error: Error | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
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
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.log?.(`event listener failed: ${(err as Error).message}`);
      }
    }
  }
}
