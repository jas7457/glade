import { execFile } from "node:child_process";
import { rm, rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  clampThinkingLevel,
  defaultSessionState,
  modelKey,
  type AgentEvent,
  type ModelInfo,
  type ModelRef,
  type PromptRequest,
  type SessionState,
  type ThinkingLevel,
  type Transcript,
  type UiResponse,
} from "@pi-ui/protocol";
import type { AgentHarness, GenerateTitleOptions, HarnessSession, OpenSessionOptions } from "../types.js";
import { PiRpcProcess } from "./rpc-process.js";
import { PiEventTranslator, translateMessages, translateModel, translateState, type PiModel } from "./translate.js";

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
    const session = new PiSession(proc, this.options.log);
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

export class PiSession implements HarnessSession {
  private state: SessionState = defaultSessionState();
  private ref: string | null = null;
  private readonly translator = new PiEventTranslator();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly exitListeners = new Set<(error: Error | null) => void>();
  private disposed = false;

  constructor(
    private readonly proc: PiRpcProcess,
    private readonly log?: (msg: string) => void,
  ) {
    proc.on("event", (raw) => {
      for (const event of this.translator.translate(raw)) {
        if (event.type === "state") this.state = { ...this.state, ...event.state };
        this.emit(event);
      }
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
    ]);
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
