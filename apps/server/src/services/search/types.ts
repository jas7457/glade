/**
 * Harness-agnostic inputs of the search service (I-045/I-046). `create.ts` builds them from each
 * registered harness: a {@link SessionTextReader} from `AgentHarness.statSession` +
 * `readSessionText`, and a {@link SmallModel} from `AgentHarness.complete` (I-067).
 */
import type { ModelRef } from "@glade/protocol";
import type { SessionFileStat, SessionText } from "../../harness/types.js";

export type { SessionFileStat, SessionText, SessionTextMessage } from "../../harness/types.js";

export interface SessionTextReader {
  /** `null` when the session has no persisted data (yet). */
  stat(sessionRef: string): Promise<SessionFileStat | null>;
  read(sessionRef: string): Promise<SessionText | null>;
}

export interface SmallModelRequest {
  prompt: string;
  /** `null` = the harness default. */
  model: ModelRef | null;
  timeoutMs?: number;
}

/** One-shot completion with a small, fast model. Returns `null` when unavailable or on failure. */
export type SmallModel = (request: SmallModelRequest) => Promise<string | null>;
