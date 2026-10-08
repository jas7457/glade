/**
 * Claude Code as a native harness (I-173), on the official Claude Agent SDK driving the user's own
 * `claude` CLI (found on the PATH, `pathToClaudeCodeExecutable`), so their install, login and
 * settings are used; Glade stores no API keys.
 *
 * - Sessions: `claude-session.ts` (one Claude Code process per live chat, started with its first
 *   prompt). The session ref is Claude's session id.
 * - Models, the default model and folder commands come from a short-lived probe process's
 *   `initializationResult()` (no model call), cached for a minute per folder.
 * - Titles, completions and side questions: one-shot runs (`one-shot.ts`) with Haiku, no tools.
 * - Glade's sub-agent and chat tools: an in-process MCP server (`glade-tools.ts`).
 * - Transcripts are Glade's (the store, I-121); nothing is imported from Claude's files.
 * - Permission modes (I-174, capability `permissionModes`): per chat, starting from Claude Code's
 *   own `permissions.defaultMode` (`permissions.ts`).
 * - Plan usage limits (I-191, capability `usageLimits`): the SDK's experimental `/usage` data from a
 *   short-lived process, no model call (`usage.ts`), read every 5 minutes at most.
 */
import { CLAUDE_COMMAND, CLAUDE_HARNESS_ID, type FolderPermissionModes, type HarnessCapabilities, type HarnessDefaults, type ModelInfo, type ModelRef, type SlashCommand, type UsageLimits } from "@glade/protocol";
import { piChildEnv } from "../pi/child-env.js";
import { cachedWhich, findExecutable, type WhichFn } from "../which.js";
import { resolveAgentCommand, type CustomCommandFn } from "../agent-command.js";
import { claudeShim } from "./shim.js";
import type {
  AgentHarness,
  CompletionRequest,
  GenerateTitleOptions,
  HarnessDescription,
  HarnessSession,
  OpenSessionOptions,
  SideQuestionCall,
  SideQuestionResult,
} from "../types.js";
import { cleanTitle, titlePrompt } from "../title.js";
import { ClaudeSession, newClaudeSessionId, toSlashCommand, type ClaudeSessionOptions } from "./claude-session.js";
import { gladeToolSpecs } from "./glade-tools.js";
import { CLAUDE_PROVIDER, claudeModelId, findClaudeModel, translateClaudeModels } from "./models.js";
import { claudeOneShot } from "./one-shot.js";
import { claudePermissionModes, readClaudePermissionSettings, type ClaudePermissionSettings } from "./permissions.js";
import { PushQueue } from "./push-queue.js";
import { claudeUsageLimits } from "./usage.js";
import { realClaudeSdk, type ClaudeInitResult, type ClaudeModelInfo, type ClaudeSdk, type ClaudeUserInput } from "./sdk.js";

export { CLAUDE_COMMAND, CLAUDE_HARNESS_ID };
/** Cheap model for titles and completions. */
const QUICK_MODEL = "haiku";

export const CLAUDE_CAPABILITIES: HarnessCapabilities = {
  compact: true,
  exportHtml: false,
  steering: true,
  uiRequests: true,
  usageLimits: true,
  commands: true,
  subagents: true,
  shell: false,
  sideQuestions: true,
  models: true,
  permissionModes: true,
  // I-198: one-shot `complete` (and titles) for quick tasks.
  quickTasks: true,
};

export interface ClaudeHarnessOptions {
  /** The SDK (tests inject a fake). */
  sdk?: ClaudeSdk;
  /** Folder for the model-listing probe. */
  utilityCwd: string;
  /** The "Use sub-agents" setting, read at each process start. Default on. */
  subagents?: () => boolean;
  /** Is a command installed? (default: a cached PATH lookup.) */
  which?: WhichFn;
  /** Full path of a command (default: a PATH lookup). */
  findExecutable?: (command: string) => string | null;
  /**
   * The custom command in effect (I-201: Advanced on the agent's page), read at each start. With
   * leading arguments it runs through a generated script (`shim.ts`, in {@link shimDir}).
   */
  customCommand?: CustomCommandFn;
  /** Folder for the custom command's scripts (default: a temp folder). */
  shimDir?: string;
  /** Limits for every chat process (dev/testing: `GLADE_CLAUDE_MAX_BUDGET_USD`, `…_MAX_TURNS`). */
  limits?: ClaudeSessionOptions["limits"];
  /** Session hooks: tests (`cancelGraceMs`, `home`), debugging (`traceFile`). */
  session?: Partial<Pick<ClaudeSessionOptions, "cancelGraceMs" | "traceFile" | "home">>;
  /** Claude Code's permission settings (default: its settings files for the chat's folder, I-174). */
  permissionSettings?: () => ClaudePermissionSettings;
  /** Base environment (default: the server's). */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

const defaultWhich = cachedWhich();
const PROBE_TTL_MS = 60_000;

export class ClaudeHarness implements AgentHarness {
  readonly id = CLAUDE_HARNESS_ID;
  readonly info: HarnessDescription = { label: "Claude Code", capabilities: { ...CLAUDE_CAPABILITIES } };
  private readonly sdk: ClaudeSdk;
  private readonly probes = new Map<string, { at: number; value: Promise<ClaudeInitResult> }>();

  constructor(private readonly options: ClaudeHarnessOptions) {
    this.sdk = options.sdk ?? realClaudeSdk();
  }

  isInstalled(): boolean {
    return (this.options.which ?? defaultWhich)(this.command().program);
  }

  /** `claude`, or the custom command (I-201). */
  private command(): { program: string; args: string[] } {
    return resolveAgentCommand(this.options.customCommand, CLAUDE_COMMAND);
  }

  /**
   * The path handed to the SDK: `claude` (or the custom program) found on the PATH; a custom
   * command with leading arguments becomes a generated script (`shim.ts`).
   */
  private executable(): string | null {
    const { program, args } = this.command();
    const path = (this.options.findExecutable ?? ((c) => findExecutable(c)))(program);
    if (!path || !args.length) return path;
    try {
      return claudeShim(path, args, this.options.shimDir);
    } catch (err) {
      this.options.log?.(`claude: couldn't write the custom command's script: ${(err as Error).message}`);
      return null;
    }
  }

  private notFound(): string {
    const { program } = this.command();
    return `Claude Code isn't installed: \`${program}\` wasn't found on this device's PATH.`;
  }

  /** The Claude Code process environment: the server's minus Glade's own and nested-session variables. */
  private childEnv(): NodeJS.ProcessEnv {
    const env = piChildEnv(this.options.env ?? process.env);
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    return env;
  }

  // Probe (models, commands) ---------------------------------------------------------------------

  /** `initializationResult()` of a short-lived Claude Code process in `cwd` (no model call). */
  private probe(cwd: string, force = false): Promise<ClaudeInitResult> {
    const hit = this.probes.get(cwd);
    if (hit && !force && Date.now() - hit.at < PROBE_TTL_MS) return hit.value;
    const value = this.runProbe(cwd);
    this.probes.set(cwd, { at: Date.now(), value });
    value.catch(() => this.probes.delete(cwd));
    return value;
  }

  private async runProbe(cwd: string): Promise<ClaudeInitResult> {
    const executable = this.executable();
    if (!executable) throw new Error(this.notFound());
    const input = new PushQueue<ClaudeUserInput>();
    const query = await this.sdk.query({
      prompt: input,
      options: { cwd, pathToClaudeCodeExecutable: executable, env: { ...this.childEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: "glade" }, persistSession: false },
    });
    try {
      return await withTimeout(query.initializationResult(), 30_000, "Claude Code didn't start");
    } finally {
      input.close();
      query.close();
    }
  }

  private async claudeModels(force = false): Promise<ClaudeModelInfo[]> {
    return (await this.probe(this.options.utilityCwd, force)).models ?? [];
  }

  async listModels(force = false): Promise<ModelInfo[]> {
    if (!this.isInstalled()) return [];
    const models = translateClaudeModels(await this.claudeModels(force));
    // Claude Code's own default first: a new chat without a Glade default starts on it, not on
    // whichever model happens to be listed first (often the priciest).
    const def = (await this.getDefaults().catch(() => null))?.model;
    const at = def ? models.findIndex((m) => m.id === def.id) : -1;
    return at > 0 ? [models[at]!, ...models.slice(0, at), ...models.slice(at + 1)] : models;
  }

  /** Claude Code's default model (its "default" entry, resolved to a listed alias when possible). */
  async getDefaults(force = false): Promise<HarnessDefaults> {
    if (!this.isInstalled()) return { model: null, thinkingLevel: null };
    const models = await this.claudeModels(force).catch(() => [] as ClaudeModelInfo[]);
    const fallback = models.find((m) => m.value === "default");
    const resolved = fallback?.resolvedModel ? findClaudeModel(models.filter((m) => m.value !== "default"), fallback.resolvedModel) : undefined;
    return { model: resolved ? { provider: CLAUDE_PROVIDER, id: resolved.value } : null, thinkingLevel: null };
  }

  async listFolderCommands(cwd: string): Promise<SlashCommand[]> {
    return (await this.probe(cwd)).commands.map(toSlashCommand);
  }

  /**
   * The new-chat mode pill (I-184): the modes a chat on `model` offers (Auto only when the model
   * supports it) and Claude Code's own `permissions.defaultMode` for the folder, like a new chat's
   * `init` works them out.
   */
  async getPermissionModes(cwd: string, model: ModelRef | null): Promise<FolderPermissionModes> {
    if (!this.isInstalled()) return { modes: [], defaultMode: null };
    const models = await this.claudeModels().catch(() => [] as ClaudeModelInfo[]);
    const info = findClaudeModel(models, claudeModelId(model));
    const resolved = info?.value === "default" && info.resolvedModel ? findClaudeModel(models, info.resolvedModel) : undefined;
    const supportsAutoMode = (info?.supportsAutoMode ?? resolved?.supportsAutoMode) === true;
    let settings: ClaudePermissionSettings = { defaultMode: null, bypassDisabled: false };
    try {
      settings = (this.options.permissionSettings ?? (() => readClaudePermissionSettings(cwd)))();
    } catch (err) {
      this.options.log?.(`claude: reading permission settings failed: ${(err as Error).message}`);
    }
    const wanted = settings.defaultMode ?? "default";
    const modes = claudePermissionModes({ supportsAutoMode }, { bypassDisabled: settings.bypassDisabled, current: wanted });
    return { modes, defaultMode: modes.some((m) => m.id === wanted) ? wanted : "default" };
  }

  // Usage limits (I-191) --------------------------------------------------------------------------

  /** Reading them starts a Claude Code process (~1 s), so less often than other agents. */
  readonly usageLimitsPolling = { intervalMs: 5 * 60_000, minIntervalMs: 60_000 };

  /** Plan limits from a short-lived Claude Code process's `/usage` data (no model call). */
  async getUsageLimits(): Promise<UsageLimits | null> {
    const executable = this.isInstalled() ? this.executable() : null;
    if (!executable) return null;
    const input = new PushQueue<ClaudeUserInput>();
    const query = await this.sdk.query({
      prompt: input,
      // No settings/MCP servers: only the login matters, and the process starts faster.
      options: {
        cwd: this.options.utilityCwd,
        pathToClaudeCodeExecutable: executable,
        env: { ...this.childEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: "glade" },
        persistSession: false,
        settingSources: [],
        strictMcpConfig: true,
      },
    });
    try {
      if (!query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) return null;
      const response = await withTimeout(query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 30_000, "Claude Code's usage didn't answer");
      return claudeUsageLimits(response);
    } finally {
      input.close();
      query.close();
    }
  }

  // Sessions ------------------------------------------------------------------------------------

  async openSession(options: OpenSessionOptions): Promise<HarnessSession> {
    const env = options.env ?? {};
    const session = new ClaudeSession({
      sdk: this.sdk,
      executable: () => this.executable(),
      cwd: options.cwd,
      sessionRef: options.sessionRef ?? newClaudeSessionId(),
      existing: options.sessionRef !== null,
      model: options.model ?? null,
      thinkingLevel: options.thinkingLevel ?? null,
      permissionMode: options.permissionMode ?? null,
      permissionSettings: this.options.permissionSettings ?? (() => readClaudePermissionSettings(options.cwd)),
      ...(options.appendSystemPrompt ? { appendSystemPrompt: options.appendSystemPrompt } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      env: this.childEnv(),
      gladeTools: () => gladeToolSpecs({ env, subagents: this.options.subagents?.() ?? true, cwd: options.cwd, fetch: this.options.fetch }),
      models: () => this.claudeModels(),
      folderCommands: () => this.listFolderCommands(options.cwd),
      ...(this.options.limits ? { limits: this.options.limits } : {}),
      ...this.options.session,
      log: this.options.log,
    });
    await session.init();
    return session;
  }

  async deleteSession(sessionRef: string): Promise<void> {
    // Claude Code's file of the session (searched in all its project folders).
    await this.sdk.deleteSession(sessionRef).catch(() => {});
  }

  // One-shot runs ---------------------------------------------------------------------------------

  async complete({ prompt, model, cwd, timeoutMs }: CompletionRequest): Promise<string | null> {
    const executable = this.executable();
    if (!executable) return null;
    const result = await claudeOneShot({
      sdk: this.sdk,
      executable,
      env: this.childEnv(),
      cwd: cwd ?? this.options.utilityCwd,
      prompt,
      model: claudeModelId(model) ?? QUICK_MODEL,
      ...(timeoutMs ? { timeoutMs } : {}),
      log: this.options.log,
    });
    return result.error || !result.text.trim() ? null : result.text;
  }

  /** Titles always use Haiku (whatever the chat's model): cheap and quick. */
  async generateTitle({ firstMessage, excerpt, cwd }: GenerateTitleOptions): Promise<string | null> {
    return cleanTitle(await this.complete({ prompt: titlePrompt(firstMessage, excerpt), model: null, cwd }));
  }

  async answerSideQuestion(call: SideQuestionCall): Promise<SideQuestionResult> {
    const executable = this.executable();
    if (!executable) return { answer: "", error: "Claude Code isn't installed" };
    const result = await claudeOneShot({
      sdk: this.sdk,
      executable,
      env: this.childEnv(),
      cwd: call.cwd,
      prompt: call.prompt,
      systemPrompt: call.systemPrompt,
      model: claudeModelId(call.model) ?? QUICK_MODEL,
      signal: call.signal,
      onDelta: call.onDelta,
      timeoutMs: 5 * 60_000,
      log: this.options.log,
    });
    return { answer: result.text, ...(result.error ? { error: result.error } : {}) };
  }

  async dispose(): Promise<void> {}
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
