/**
 * Codex as a native harness (I-177), speaking the `codex app-server` JSON-RPC protocol (what
 * Codex's VS Code extension uses) with the user's own `codex` (found on the PATH): its login
 * (`~/.codex`) and config apply, Glade stores no keys.
 *
 * - One app-server process per Glade server, shared by every Codex chat (`app-server.ts`); each
 *   chat is a thread (`codex-session.ts`). The session ref is the thread id.
 * - Models and reasoning efforts from `model/list` (`models.ts`), Codex's configured model first.
 * - Permission modes (I-174): Codex's presets Read only / Auto / Full access, plus Plan mode
 *   (Codex's Plan collaboration mode, I-186) (`permissions.ts`).
 * - Usage limits: `account/rateLimits/read` for the gauge and the "usage limit reached" message.
 * - Titles and side questions: none of Codex's own (a one-shot run would spend the user's Codex
 *   usage), so titles fall back to the first message (`canGenerateTitles` is false).
 * - Glade's sub-agent and chat tools: dynamic tools on the thread (`glade-tools.ts`).
 * - Slash commands (I-178): Codex's skills for the folder (`skills/list`) and `/review`
 *   (`commands.ts`); `!cmd` / `!!cmd` run with `command/exec` (`codex-session.ts`).
 * - Transcripts are Glade's (the store, I-121); nothing is imported from Codex's rollout files.
 */
import { CODEX_COMMAND, CODEX_HARNESS_ID, type HarnessCapabilities, type HarnessDefaults, type ModelInfo, type SlashCommand, type UsageLimits } from "@glade/protocol";
import { piChildEnv } from "../pi/child-env.js";
import { cachedWhich, findExecutable, type WhichFn } from "../which.js";
import type { AgentHarness, HarnessDescription, HarnessSession, OpenSessionOptions } from "../types.js";
import { CodexAppServer } from "./app-server.js";
import { CodexSession, type CodexSessionOptions } from "./codex-session.js";
import { codexSlashCommands } from "./commands.js";
import { NOT_INSTALLED, codexUsageLimits } from "./errors.js";
import { codexGladeTools } from "./glade-tools.js";
import { CODEX_PROVIDER, defaultLevel, findCodexModel, translateCodexModels } from "./models.js";
import { spawnCodexTransport, traceCodexTransport, type CodexTransport } from "./rpc.js";

export { CODEX_COMMAND, CODEX_HARNESS_ID };

export const CODEX_CAPABILITIES: HarnessCapabilities = {
  compact: true,
  exportHtml: false,
  steering: true,
  uiRequests: true,
  usageLimits: true,
  commands: true,
  subagents: true,
  shell: true,
  sideQuestions: false,
  models: true,
  permissionModes: true,
};

export interface CodexHarnessOptions {
  /** Folder the app-server process runs in. */
  utilityCwd: string;
  /** Start the app-server's transport (tests inject a fake); default: `codex app-server` on the PATH. */
  connect?: (spawn: { executable: string; cwd: string; env: NodeJS.ProcessEnv }) => CodexTransport;
  /** The "Use sub-agents" setting, read when a thread starts. Default on. */
  subagents?: () => boolean;
  /** Is a command installed? (default: a cached PATH lookup.) */
  which?: WhichFn;
  /** Full path of a command (default: a PATH lookup). */
  findExecutable?: (command: string) => string | null;
  /** Base environment (default: the server's). */
  env?: NodeJS.ProcessEnv;
  /** Session hooks for tests. */
  session?: Partial<Pick<CodexSessionOptions, "cancelGraceMs">>;
  version?: string;
  /** Append every app-server message to this JSONL file (debugging: `GLADE_CODEX_TRACE`). */
  traceFile?: string;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
}

const defaultWhich = cachedWhich();

/** Codex's own variables of a Codex session the server may run in (never inherited). */
const CODEX_SESSION_ENV = /^CODEX_(SANDBOX|THREAD_ID|CI$|MANAGED_BY)/;

export class CodexHarness implements AgentHarness {
  readonly id = CODEX_HARNESS_ID;
  readonly info: HarnessDescription = { label: "Codex", capabilities: { ...CODEX_CAPABILITIES } };
  readonly server: CodexAppServer;

  constructor(private readonly options: CodexHarnessOptions) {
    this.server = new CodexAppServer({
      connect: () => {
        const executable = this.executable();
        if (!executable) throw new Error(NOT_INSTALLED);
        const spawn = { executable, cwd: options.utilityCwd, env: this.childEnv() };
        const transport = options.connect ? options.connect(spawn) : spawnCodexTransport(spawn);
        return options.traceFile ? traceCodexTransport(transport, options.traceFile) : transport;
      },
      ...(options.version ? { version: options.version } : {}),
      log: options.log,
    });
  }

  isInstalled(): boolean {
    return (this.options.which ?? defaultWhich)(CODEX_COMMAND);
  }

  private executable(): string | null {
    return (this.options.findExecutable ?? ((c) => findExecutable(c)))(CODEX_COMMAND);
  }

  /** The app-server's environment: the server's minus Glade's own and a parent Codex session's variables. */
  childEnv(): NodeJS.ProcessEnv {
    const env = piChildEnv(this.options.env ?? process.env);
    for (const key of Object.keys(env)) if (CODEX_SESSION_ENV.test(key)) delete env[key];
    return env;
  }

  async listModels(force = false): Promise<ModelInfo[]> {
    if (!this.isInstalled()) return [];
    const [models, config] = await Promise.all([this.server.listModels(force), this.server.config().catch(() => null)]);
    return translateCodexModels(models, config?.model ?? null);
  }

  /** Codex's configured model and effort (`config.toml`), else its default model. */
  async getDefaults(force = false): Promise<HarnessDefaults> {
    if (!this.isInstalled()) return { model: null, thinkingLevel: null };
    const models = await this.server.listModels(force).catch(() => []);
    const config = await this.server.config().catch(() => null);
    const model = findCodexModel(models, config?.model) ?? models.find((m) => m.isDefault);
    if (!model) return { model: null, thinkingLevel: null };
    return { model: { provider: CODEX_PROVIDER, id: model.id }, thinkingLevel: defaultLevel(model, config?.model === model.id ? config.model_reasoning_effort : null) };
  }

  /** Codex's commands and the folder's skills (the new-chat composer's `/` menu). */
  async listFolderCommands(cwd: string): Promise<SlashCommand[]> {
    if (!this.isInstalled()) return [];
    return codexSlashCommands(await this.server.skills(cwd).catch(() => []));
  }

  async openSession(options: OpenSessionOptions): Promise<HarnessSession> {
    const env = options.env ?? {};
    const session = new CodexSession({
      server: this.server,
      cwd: options.cwd,
      sessionRef: options.sessionRef,
      model: options.model ?? null,
      thinkingLevel: options.thinkingLevel ?? null,
      permissionMode: options.permissionMode ?? null,
      ...(options.appendSystemPrompt ? { developerInstructions: options.appendSystemPrompt } : {}),
      ...(childShell(this.options.env ?? process.env) ? { shell: childShell(this.options.env ?? process.env)! } : {}),
      gladeTools: () => codexGladeTools({ env, subagents: this.options.subagents?.() ?? true, cwd: options.cwd, ...(this.options.fetch ? { fetch: this.options.fetch } : {}) }),
      ...this.options.session,
      log: this.options.log,
    });
    await session.init();
    return session;
  }

  /** Deletes Codex's saved thread with the chat (`thread/delete`); never other threads. */
  async deleteSession(sessionRef: string): Promise<void> {
    if (!this.isInstalled()) return;
    await this.server.request("thread/delete", { threadId: sessionRef }, 15_000).catch((err: Error) => this.options.log?.(`codex: deleting ${sessionRef} failed: ${err.message}`));
  }

  async getUsageLimits(): Promise<UsageLimits | null> {
    if (!this.isInstalled()) return null;
    const limits = await this.server.rateLimits();
    return limits ? codexUsageLimits(limits) : null;
  }

  async dispose(): Promise<void> {
    await this.server.dispose();
  }
}

/** The user's login shell for `!cmd`. */
function childShell(env: NodeJS.ProcessEnv): string | undefined {
  return env.SHELL || undefined;
}
