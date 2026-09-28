/**
 * What Glade keeps per ACP chat to resume it (I-119, I-121): the agent's own session id (for
 * `session/load` / `session/resume`) and the chat's title. The conversation itself is in Glade's
 * store like every harness's (written by the live pool); the old `<dataDir>/acp-sessions/*.json`
 * copies are imported once and no longer written.
 *
 * `sessionRef` is Glade's id for the chat's ACP session (the ACP session id changes when an agent
 * can't resume). The server backs this with `sessions.resume_json`; tests use the memory one.
 */
import { randomUUID } from "node:crypto";

export interface AcpResumeState {
  /** The agent's session id; `null` before the first start. */
  acpSessionId: string | null;
  title: string | null;
}

export interface AcpResumeStore {
  load(ref: string): AcpResumeState | null;
  save(ref: string, state: AcpResumeState): void;
  delete(ref: string): void;
}

export function newAcpSessionRef(): string {
  return randomUUID();
}

/** Resume state in memory (tests; and the fallback until the chat's record exists). */
export class MemoryAcpResumeStore implements AcpResumeStore {
  private readonly map = new Map<string, AcpResumeState>();
  load(ref: string): AcpResumeState | null {
    return this.map.get(ref) ?? null;
  }
  save(ref: string, state: AcpResumeState): void {
    this.map.set(ref, state);
  }
  delete(ref: string): void {
    this.map.delete(ref);
  }
}
