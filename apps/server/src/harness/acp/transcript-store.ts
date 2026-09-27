/**
 * Glade's own copy of each ACP chat (I-119). ACP agents keep their history inside the agent (if at
 * all) and only hand it back through `session/load`, which needs the agent running; the sidebar,
 * search, Ask and reloads need it without that. So every ACP session has a JSON file:
 *
 *   <dir>/<sessionRef>.json  { version, harness, acpSessionId, cwd, title, createdAt, transcript }
 *
 * `sessionRef` is Glade's id (the ACP session id changes when an agent can't resume). Written
 * atomically (temp file + rename) after every finished message, tool call and run.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyTranscript, type Transcript } from "@glade/protocol";

export interface AcpSessionFile {
  version: 1;
  /** Harness id (`acp-<agent>`). */
  harness: string;
  /** The agent's session id (for `session/load` / `session/resume`); `null` before the first start. */
  acpSessionId: string | null;
  cwd: string;
  title: string | null;
  createdAt: number;
  transcript: Transcript;
}

export class AcpTranscriptStore {
  constructor(readonly dir: string) {}

  newRef(): string {
    return randomUUID();
  }

  private path(ref: string): string {
    // Refs are our own UUIDs; refuse anything that could leave the folder.
    if (!/^[A-Za-z0-9_-]+$/.test(ref)) throw new Error(`Invalid ACP session ref: ${ref}`);
    return join(this.dir, `${ref}.json`);
  }

  read(ref: string): AcpSessionFile | null {
    try {
      const file = JSON.parse(readFileSync(this.path(ref), "utf8")) as AcpSessionFile;
      if (!file || file.version !== 1 || !file.transcript) return null;
      return { ...file, transcript: settle(file.transcript) };
    } catch {
      return null;
    }
  }

  write(ref: string, file: AcpSessionFile): void {
    mkdirSync(this.dir, { recursive: true });
    const target = this.path(ref);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file));
    renameSync(tmp, target);
  }

  stat(ref: string): { mtimeMs: number; size: number } | null {
    try {
      const s = statSync(this.path(ref));
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  }

  delete(ref: string): void {
    rmSync(this.path(ref), { force: true });
  }
}

/**
 * A transcript read back from disk can't still be streaming: a run cut off by a crash or quit
 * shows its last message as finished and its unfinished tool calls as failed.
 */
export function settle(t: Transcript): Transcript {
  const messages = t.messages.map((m) => (m.role === "assistant" && m.streaming ? { ...m, streaming: false } : m));
  const toolResults = Object.fromEntries(
    Object.entries(t.toolResults).map(([id, r]) => [id, r.status === "running" ? { ...r, status: "error" as const, output: r.output || "Interrupted" } : r]),
  );
  return { messages, toolResults };
}

export function emptySessionFile(harness: string, cwd: string): AcpSessionFile {
  return { version: 1, harness, acpSessionId: null, cwd, title: null, createdAt: Date.now(), transcript: emptyTranscript() };
}
