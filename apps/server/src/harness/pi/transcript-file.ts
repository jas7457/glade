/**
 * Builds a transcript straight from a pi session file (`*.jsonl`), without starting pi (I-054):
 * used to show a closed sub-agent's conversation without restarting its process. Walks the
 * active branch (last entry back to the root via `parentId`), keeps `message` entries (user,
 * assistant, tool results, bash…) and displayed `custom_message`s, and translates them like
 * pi's `get_messages` response. Compaction is shown as a notice; older messages stay visible.
 * See pi's docs/session-format.md.
 */
import { readFile } from "node:fs/promises";
import type { Transcript } from "@pi-ui/protocol";
import { translateMessages } from "./translate.js";

type Json = Record<string, unknown>;

/** Pure; exported for tests. */
export function transcriptFromPiSession(content: string): Transcript {
  const entries: Json[] = [];
  const byId = new Map<string, Json>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry: Json;
    try {
      entry = JSON.parse(line) as Json;
    } catch {
      continue; // partial last line while pi is writing
    }
    if (typeof entry.id !== "string" || entry.type === "session") continue;
    entries.push(entry);
    byId.set(entry.id, entry);
  }
  let branch: Json[] = [];
  const seen = new Set<string>();
  for (let e = entries.at(-1); e && !seen.has(e.id as string); e = typeof e.parentId === "string" ? byId.get(e.parentId) : undefined) {
    seen.add(e.id as string);
    branch.push(e);
    if (typeof e.parentId === "string" && !byId.has(e.parentId)) {
      branch = [...entries].reverse(); // broken chain: fall back to file order
      break;
    }
  }
  branch.reverse();
  const messages: Json[] = [];
  for (const e of branch) {
    if (e.type === "message" && e.message && typeof e.message === "object") messages.push(e.message as Json);
    else if (e.type === "custom_message") {
      messages.push({ role: "custom", content: e.content, display: e.display, timestamp: Date.parse(String(e.timestamp ?? "")) || 0 });
    } else if (e.type === "compaction") {
      messages.push({ role: "compactionSummary", tokensBefore: e.tokensBefore, timestamp: Date.parse(String(e.timestamp ?? "")) || 0 });
    }
  }
  return translateMessages(messages, (i) => `f${i}`);
}

/** The transcript of a session file, or `null` if it can't be read. */
export async function readPiTranscript(sessionRef: string): Promise<Transcript | null> {
  try {
    return transcriptFromPiSession(await readFile(sessionRef, "utf8"));
  } catch {
    return null;
  }
}
