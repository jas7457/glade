/**
 * Harness-agnostic inputs of the search service (I-045/I-046). `create.ts` builds them from the
 * store (I-121: every conversation's text is in its `messages` rows) and the default harness's
 * `AgentHarness.complete` as the {@link SmallModel} (I-067).
 */
import type { ModelRef, SessionSummary } from "@glade/protocol";
import type { SessionFileStat, SessionText } from "../../harness/types.js";

export type { SessionFileStat, SessionText, SessionTextMessage } from "../../harness/types.js";

/** Reads a harness's persisted sessions by reference (pi's JSONL; import and tests only). */
export interface SessionTextReader {
  /** `null` when the session has no persisted data (yet). */
  stat(sessionRef: string): Promise<SessionFileStat | null>;
  read(sessionRef: string): Promise<SessionText | null>;
}

/** Where search reads each session's text. */
export interface SessionTextSource {
  /** Changes whenever the session's text may have changed; `null` when nothing is stored. */
  version(session: SessionSummary): Promise<string | null> | string | null;
  read(session: SessionSummary): Promise<SessionText | null> | SessionText | null;
}

export interface StoredSummary {
  text: string;
  /** Number of messages summarized (a new summary is due when it changes). */
  messageCount: number;
  at: number;
}

/** Where chat summaries are kept (the store's `session_summaries`). */
export interface SummaryStore {
  get(sessionId: string): StoredSummary | null;
  list(): Map<string, StoredSummary>;
  set(sessionId: string, summary: StoredSummary): void;
  remove(sessionIds: readonly string[]): void;
  /** When summaries were first enabled (set on first call); older untouched chats aren't backfilled. */
  enabledAt(now: number): number;
}

export interface SmallModelRequest {
  prompt: string;
  /** `null` = the harness default. */
  model: ModelRef | null;
  timeoutMs?: number;
}

/** One-shot completion with a small, fast model. Returns `null` when unavailable or on failure. */
export type SmallModel = (request: SmallModelRequest) => Promise<string | null>;
