/**
 * Harness-agnostic inputs of the search service (I-045/I-046). A harness adapter provides a
 * {@link SessionTextReader} (e.g. pi: `harness/pi/session-reader.ts`) and optionally a
 * {@link FastModel} for one-shot completions (pi: `harness/pi/one-shot.ts`).
 */
import type { ModelRef } from "@pi-ui/protocol";

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

/** Cheap change detection for a session's persisted file. */
export interface SessionFileStat {
  mtimeMs: number;
  size: number;
}

export interface SessionTextReader {
  /** `null` when the session has no persisted data (yet). */
  stat(sessionRef: string): Promise<SessionFileStat | null>;
  read(sessionRef: string): Promise<SessionText | null>;
}

export interface FastModelRequest {
  prompt: string;
  /** `null` = the harness default. */
  model: ModelRef | null;
  timeoutMs?: number;
}

/** One-shot completion with a small, fast model. Returns `null` when unavailable or on failure. */
export type FastModel = (request: FastModelRequest) => Promise<string | null>;
