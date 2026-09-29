/**
 * The harness abstraction. pi is the first implementation; others (e.g. Claude Code) can be
 * added by implementing these two interfaces and registering them in `src/index.ts` (a
 * {@link HarnessRegistry}, `harness/registry.ts`). Optional methods are features a harness may
 * lack; `info.capabilities` tells the web which controls to show (I-065).
 *
 * Everything crossing this boundary uses `@glade/protocol` types - never harness-native ones.
 */
import type {
  AgentEvent,
  CompactResult,
  HarnessCapabilities,
  HarnessDefaults,
  ModelInfo,
  ModelRef,
  PromptRequest,
  SessionState,
  ShellResult,
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

/** A shell command the user runs in the session's folder (`!cmd` / `!!cmd`, I-076). */
export interface ShellRunRequest {
  /** Id for the `shell_*` events and the transcript's `ShellMessage` (chosen by the caller). */
  id: string;
  command: string;
  /** false = never show it to the agent (`!!cmd`). */
  shareWithAgent: boolean;
}

export interface GenerateTitleOptions {
  firstMessage: string;
  /**
   * A compact excerpt of the whole conversation (`conversationExcerpt` in `title.ts`): title the
   * conversation so far instead of only its first message (`/name` without a title, I-074).
   */
  excerpt?: string;
  cwd: string;
  model: ModelRef | null;
}

/** What the web is told about a harness (`GET /api/harnesses`, I-065). */
export interface HarnessDescription {
  /** Display name ("pi", "Claude Code"). */
  label: string;
  capabilities: HarnessCapabilities;
}

/** One message of a persisted conversation's searchable text (search, I-045). */
export interface SessionTextMessage {
  role: "user" | "assistant";
  /** Plain text (no tool output, no thinking). */
  text: string;
  /** ms epoch (0 if unknown). */
  timestamp: number;
}

/** The searchable text of one persisted conversation. */
export interface SessionText {
  /** Name stored in the session file, if any. */
  name: string | null;
  messages: SessionTextMessage[];
}

/** Cheap change detection for a session's persisted data. */
export interface SessionFileStat {
  mtimeMs: number;
  size: number;
}

/** A one-shot completion (titles, chat summaries, the chat finder; I-067). */
export interface CompletionRequest {
  prompt: string;
  /** `null` = the harness default. */
  model: ModelRef | null;
  /** Working directory (default: a harness utility folder). */
  cwd?: string;
  timeoutMs?: number;
}

/**
 * A side question (I-140): one answer over a prompt Glade built from the chat's transcript, with
 * no tools and without touching the chat's session. Capability `sideQuestions`.
 */
export interface SideQuestionCall {
  /** The serialized conversation + the question (`buildSideQuestionPrompt`). */
  prompt: string;
  systemPrompt: string;
  /** `null` = the harness default. */
  model: ModelRef | null;
  /** The chat's folder. */
  cwd: string;
  /** Stop: resolve with what was answered so far. */
  signal: AbortSignal;
  /** Called with each piece of the answer as it streams. */
  onDelta(delta: string): void;
}

export interface SideQuestionResult {
  /** The whole answer (the partial one when stopped or failed). */
  answer: string;
  /** Set when it failed. */
  error?: string;
}

export interface AgentHarness {
  /** Stable identifier persisted on chats (e.g. "pi"). */
  readonly id: string;
  /** Label + capabilities (I-065). */
  readonly info: HarnessDescription;
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
   * **Import only** (I-121): the harness's own persisted transcript, read without starting an
   * agent. Glade stores every conversation itself; this is how chats from before that (and turns
   * added outside Glade, e.g. pi resumed in a terminal) get into the store. `null` if unreadable.
   */
  readTranscript?(sessionRef: string): Promise<Transcript | null>;
  /**
   * **Import only** (I-121): change detection for the harness's persisted session; the store
   * re-imports (merges) when it differs from the last one seen in sync. `null` when it has no
   * persisted data (yet).
   */
  statSession?(sessionRef: string): Promise<SessionFileStat | null>;
  /**
   * **Import only / unused by the app** (I-121): the user/assistant text of a persisted session.
   * Search, titles and chat tools read the store instead.
   */
  readSessionText?(sessionRef: string): Promise<SessionText | null>;
  /**
   * One-shot completion with no tools and no session (titles, summaries, the chat finder).
   * Returns `null` when unavailable or on failure; never throws.
   */
  complete?(request: CompletionRequest): Promise<string | null>;
  /**
   * One-shot short title for a conversation. Returns `null` if unavailable. Optional: without it
   * titles are generated with {@link complete} (`harness/title.ts`).
   */
  generateTitle?(options: GenerateTitleOptions): Promise<string | null>;
  /**
   * Answer a side question (I-140; capability `sideQuestions`). Never rejects: failures resolve
   * with `error`, a stop (`signal`) with the partial answer.
   */
  answerSideQuestion?(call: SideQuestionCall): Promise<SideQuestionResult>;
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
  /**
   * Run a shell command in the session's folder (I-076; capability `shell`). Emits `shell_start`,
   * `shell_update`s and `shell_end` with `request.id` and resolves with the result when it ends
   * (never rejects: failures end with `result.error`). Allowed while the agent is running. When
   * shared, the harness gives the agent the command and output with the next prompt.
   */
  runShell?(request: ShellRunRequest): Promise<ShellResult>;
  /** Stop the running shell command(s). */
  abortShell?(): Promise<void>;
  /** Subscribe to normalized events. Returns an unsubscribe function. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /** Called once if the underlying agent dies unexpectedly. */
  onExit(listener: (error: Error | null) => void): () => void;
  dispose(): Promise<void>;
}
