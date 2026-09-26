/**
 * The harness abstraction. pi is the first implementation; others (e.g. Claude Code) can be
 * added by implementing these two interfaces and registering them in `harness/registry.ts`.
 *
 * Everything crossing this boundary uses `@pi-ui/protocol` types - never harness-native ones.
 */
import type {
  AgentEvent,
  ModelInfo,
  ModelRef,
  PromptRequest,
  SessionState,
  ThinkingLevel,
  Transcript,
  UiResponse,
} from "@pi-ui/protocol";

export interface OpenSessionOptions {
  /** Working directory for the agent. */
  cwd: string;
  /** Existing session to resume, or `null` to start a new one. */
  sessionRef: string | null;
  model?: ModelRef | null;
  thinkingLevel?: ThinkingLevel | null;
}

export interface GenerateTitleOptions {
  firstMessage: string;
  cwd: string;
  model: ModelRef | null;
}

export interface AgentHarness {
  /** Stable identifier persisted on chats (e.g. "pi"). */
  readonly id: string;
  listModels(): Promise<ModelInfo[]>;
  openSession(options: OpenSessionOptions): Promise<HarnessSession>;
  /** Permanently remove a persisted session. */
  deleteSession(sessionRef: string): Promise<void>;
  /** One-shot short title for a conversation. Returns `null` if unavailable. */
  generateTitle?(options: GenerateTitleOptions): Promise<string | null>;
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
  /** Subscribe to normalized events. Returns an unsubscribe function. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
  /** Called once if the underlying agent dies unexpectedly. */
  onExit(listener: (error: Error | null) => void): () => void;
  dispose(): Promise<void>;
}
