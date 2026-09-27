/**
 * The harness abstraction. pi is the first implementation; others (e.g. Claude Code) can be
 * added by implementing these two interfaces and registering them in `src/index.ts`.
 *
 * Everything crossing this boundary uses `@glade/protocol` types - never harness-native ones.
 */
import type {
  AgentEvent,
  CompactResult,
  HarnessDefaults,
  ModelInfo,
  ModelRef,
  PromptRequest,
  SessionState,
  SlashCommand,
  ThinkingLevel,
  Transcript,
  UiResponse,
  UsageLimits,
} from "@glade/protocol";

export interface OpenSessionOptions {
  /** Working directory for the agent. */
  cwd: string;
  /** Existing session to resume, or `null` to start a new one. */
  sessionRef: string | null;
  model?: ModelRef | null;
  thinkingLevel?: ThinkingLevel | null;
  /** Extra environment for the agent process (agent API identity, I-037). */
  env?: Record<string, string>;
  /** Text appended to the agent's system prompt (sub-agent role, I-037). */
  appendSystemPrompt?: string;
  /** Tool allowlist (sub-agents from a definition with `tools`, I-037). */
  tools?: string[];
}

export interface GenerateTitleOptions {
  firstMessage: string;
  cwd: string;
  model: ModelRef | null;
}

export interface AgentHarness {
  /** Stable identifier persisted on chats (e.g. "pi"). */
  readonly id: string;
  /** Available models. Implementations may cache; `force` bypasses the cache. */
  listModels(force?: boolean): Promise<ModelInfo[]>;
  /** Model/thinking level the harness uses when none is given (I-050). `force` refreshes. */
  getDefaults?(force?: boolean): Promise<HarnessDefaults>;
  /** Slash commands available in `cwd` without an open session (I-043). Callers cache. */
  listFolderCommands?(cwd: string): Promise<SlashCommand[]>;
  openSession(options: OpenSessionOptions): Promise<HarnessSession>;
  /** Permanently remove a persisted session. */
  deleteSession(sessionRef: string): Promise<void>;
  /**
   * Read a persisted session's transcript without starting an agent (I-054: closed sub-agents
   * are shown without restarting them). `null` if unreadable. Optional: callers start it instead.
   */
  readTranscript?(sessionRef: string): Promise<Transcript | null>;
  /** One-shot short title for a conversation. Returns `null` if unavailable. */
  generateTitle?(options: GenerateTitleOptions): Promise<string | null>;
  /** Subscription/plan usage limits for the harness's current account, or `null` if unavailable. */
  getUsageLimits?(): Promise<UsageLimits | null>;
  dispose(): Promise<void>;
}

export interface HarnessSession {
  /** Reference to the persisted session (stable once known). */
  readonly sessionRef: string | null;
  /** Latest known state (kept up to date from events). */
  getState(): SessionState;
  /** Full transcript as currently persisted by the harness. */
  loadTranscript(): Promise<Transcript>;
  prompt(request: PromptRequest): Promise<void>;
  abort(): Promise<void>;
  setModel(model: ModelRef): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): Promise<void>;
  setTitle(title: string): Promise<void>;
  respondToUi(response: UiResponse): void;
  /** Harness-provided slash commands (extensions, skills, prompt templates). Built-ins are Glade's. */
  listCommands?(): Promise<SlashCommand[]>;
  /** Compact the conversation context. */
  compact?(instructions?: string): Promise<CompactResult>;
  /** Export the session to an HTML file; returns its path. */
  exportHtml?(): Promise<string>;
  /** Subscribe to normalized events. Returns an unsubscribe function. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /** Called once if the underlying agent dies unexpectedly. */
  onExit(listener: (error: Error | null) => void): () => void;
  dispose(): Promise<void>;
}
