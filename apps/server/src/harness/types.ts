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
   * Read a persisted session's transcript without starting an agent (I-054: closed sub-agents
   * are shown without restarting them). `null` if unreadable. Optional: callers start it instead.
   */
  readTranscript?(sessionRef: string): Promise<Transcript | null>;
  /**
   * Change detection for a persisted session (search re-reads it when this changes, I-067).
   * `null` when it has no persisted data (yet). Search needs this and {@link readSessionText}.
   */
  statSession?(sessionRef: string): Promise<SessionFileStat | null>;
  /** The user/assistant text of a persisted session, without starting an agent (search). */
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
