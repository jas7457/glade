/**
 * Pure helpers for stored conversations (I-121): what a `messages` row holds besides the payload
 * (status, plain text, the sub-agent message kind), settling a transcript read back after a crash,
 * and merging a harness transcript (pi's JSONL) into what the store already has without
 * duplicating messages or changing their ids.
 */
import { messageText, parseAgentMessage, sideQuestionStreaming, type ChatMessage, type SideQuestionTurn, type ToolResult, type Transcript } from "@glade/protocol";

/** Version of the `payload_json` shape (the protocol's `ChatMessage` / `ToolResult`). */
export const PAYLOAD_VERSION = 1;

export type MessageStatus = "streaming" | "running" | "done";

export function messageStatus(m: ChatMessage): MessageStatus {
  if (m.role === "assistant" && m.streaming) return "streaming";
  if (m.role === "shell" && m.running) return "running";
  if (m.role === "side" && sideQuestionStreaming(m)) return "streaming";
  return "done";
}

/** Plain user/assistant text (no tools, no thinking), or null for other roles / empty text. */
export function searchableText(m: ChatMessage): string | null {
  if (m.role !== "user" && m.role !== "assistant") return null;
  const text = messageText(m).trim();
  return text || null;
}

/** A delivered sub-agent message/report (`[agent-teams] …` prompt): stored as its own kind. */
export interface AgentMessageMeta {
  kind: "finished" | "message" | "exited";
  from: string;
  /** The receiving agent: `main` for a main session, else the sub-agent's code name. */
  to: string;
  displayName?: string;
}

export function agentMessageMeta(m: ChatMessage, to: string): AgentMessageMeta | null {
  if (m.role !== "user") return null;
  const parsed = parseAgentMessage(messageText(m));
  if (!parsed) return null;
  return { kind: parsed.kind, from: parsed.from, to, ...(parsed.displayName ? { displayName: parsed.displayName } : {}) };
}

/**
 * A transcript read back can't still be streaming when no process runs it: a run cut off by a
 * crash or quit shows its last message as finished and its unfinished tools as failed.
 */
export function settleTranscript(t: Transcript): Transcript {
  let changed = false;
  const messages = t.messages.map((m) => {
    if (m.role === "assistant" && m.streaming) {
      changed = true;
      return { ...m, streaming: false };
    }
    if (m.role === "shell" && m.running) {
      changed = true;
      return { ...m, running: false, cancelled: true };
    }
    if (m.role === "side" && sideQuestionStreaming(m)) {
      changed = true;
      const stop = <T extends SideQuestionTurn>(turn: T): T => (turn.status === "streaming" ? { ...turn, status: "stopped" as const } : turn);
      return { ...stop(m), ...(m.followUps ? { followUps: m.followUps.map(stop) } : {}) };
    }
    return m;
  });
  const toolResults: Record<string, ToolResult> = {};
  for (const [id, r] of Object.entries(t.toolResults)) {
    if (r.status === "running") {
      changed = true;
      toolResults[id] = { ...r, status: "error", output: r.output || "Interrupted" };
    } else toolResults[id] = r;
  }
  return changed ? { messages, toolResults } : t;
}

/**
 * Identity of a message across a live run and a harness file. pi stamps user and assistant
 * messages with its own timestamp in both, so role + timestamp is exact. Shell commands, notices
 * and compaction dividers are stamped differently live and in the file, so they match by content
 * and occurrence (the n-th `ls` command, the n-th compaction).
 */
function baseKey(m: ChatMessage): string {
  switch (m.role) {
    case "user":
    case "assistant":
      return `${m.role}@${m.timestamp}`;
    case "shell":
      return `shell:${m.command}`;
    case "notice":
      return m.kind === "compaction" ? "notice:compaction" : `notice:${m.kind}:${m.text}`;
    case "side":
      // Glade's own (I-140): never in a harness's file, so it never matches an imported message.
      return `side:${m.id}`;
  }
}

export function messageKeys(messages: readonly ChatMessage[]): string[] {
  const seen = new Map<string, number>();
  return messages.map((m) => {
    const base = baseKey(m);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

export interface MergeResult {
  transcript: Transcript;
  /** Imported messages that weren't in the store (they got new ids). */
  added: number;
  /** Stored messages whose content was replaced by the imported (final) version. */
  updated: number;
}

/**
 * Merge `imported` (a harness's view, e.g. pi's JSONL) into `stored` (the store's). Stored
 * messages keep their ids and order; imported messages the store doesn't have get new ids and go
 * right before the next stored message they precede in the file (or at the end). A stored
 * assistant message cut off mid-stream takes the imported final version (same id). Tool results
 * are added when missing or still running in the store.
 */
export function mergeTranscripts(stored: Transcript, imported: Transcript, newId: (m: ChatMessage) => string): MergeResult {
  const storedKeys = messageKeys(stored.messages);
  const importedKeys = messageKeys(imported.messages);
  const storedIndex = new Map(storedKeys.map((k, i) => [k, i]));
  /** stored index -> index of the imported message matched to it */
  const matchedImport = new Map<number, number>();
  /** imported index -> stored index it matched (or -1) */
  const matchOf = importedKeys.map((k, j) => {
    const i = storedIndex.get(k);
    if (i === undefined) return -1;
    matchedImport.set(i, j);
    return i;
  });

  const out: ChatMessage[] = [];
  let added = 0;
  let updated = 0;
  let next = 0; // next imported index not yet placed
  const placeUnmatchedBefore = (limit: number) => {
    for (; next < limit; next++) {
      if (matchOf[next] !== -1) continue;
      const m = imported.messages[next]!;
      out.push({ ...m, id: newId(m) });
      added++;
    }
  };
  stored.messages.forEach((m, i) => {
    const j = matchedImport.get(i);
    if (j !== undefined) {
      placeUnmatchedBefore(j);
      next = Math.max(next, j + 1);
      const match = imported.messages[j]!;
      if (m.role === "assistant" && m.streaming && match.role === "assistant") {
        out.push({ ...match, id: m.id });
        updated++;
        return;
      }
    }
    out.push(m);
  });
  placeUnmatchedBefore(imported.messages.length);

  const toolResults = { ...stored.toolResults };
  for (const [id, result] of Object.entries(imported.toolResults)) {
    const existing = toolResults[id];
    if (!existing || (existing.status === "running" && result.status !== "running")) toolResults[id] = result;
  }
  return { transcript: { messages: out, toolResults }, added, updated };
}
