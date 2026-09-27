/**
 * Reads pi session files (`~/.pi/agent/sessions/…/*.jsonl`) directly, without starting an agent,
 * for search (I-045). Only the active branch is used (walk from the last entry via `parentId`),
 * and only user text and assistant text: tool calls/results, thinking, bash output and extension
 * messages are skipped. The session name comes from the latest `session_info` on the branch.
 *
 * Tool results make up most of a session file, so lines are pre-screened before `JSON.parse`:
 * the entry header (`type`, `id`, `parentId`) is read with a regex and only `message` lines with a
 * user/assistant role and `session_info` lines are parsed in full.
 * See pi's docs/session-format.md.
 */
import { readFile, stat } from "node:fs/promises";
import type { SessionFileStat, SessionText, SessionTextMessage, SessionTextReader } from "../../services/search/types.js";

interface Entry {
  id: string;
  parentId: string | null;
  /** Parsed payload for entries we care about, else `null`. */
  value: { kind: "message"; message: SessionTextMessage } | { kind: "name"; name: string } | null;
}

const HEADER = /^\{"type":"([a-z_]+)","id":"([^"]+)","parentId":(?:null|"([^"]*)")/;
const ROLE = /"message":\{"role":"([a-zA-Z]+)"/;

type Raw = Record<string, unknown>;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c): c is { type: "text"; text: string } => !!c && (c as Raw).type === "text" && typeof (c as Raw).text === "string")
    .map((c) => c.text)
    .join("\n");
}

function parseValue(type: string, raw: Raw): Entry["value"] {
  if (type === "session_info") return typeof raw.name === "string" && raw.name.trim() ? { kind: "name", name: raw.name.trim() } : null;
  if (type !== "message") return null;
  const message = raw.message as Raw | undefined;
  const role = message?.role;
  if (role !== "user" && role !== "assistant") return null;
  const text = textOf(message!.content).trim();
  if (!text) return null;
  const ts = typeof message!.timestamp === "number" ? message!.timestamp : Date.parse(String(raw.timestamp ?? "")) || 0;
  return { kind: "message", message: { role, text, timestamp: ts } };
}

function parseLine(line: string): Entry | null {
  const head = HEADER.exec(line);
  if (head) {
    const [, type, id, parentId] = head;
    const wanted =
      type === "session_info" || (type === "message" && ((r) => r === "user" || r === "assistant")(ROLE.exec(line.slice(0, 400))?.[1]));
    let value: Entry["value"] = null;
    if (wanted) {
      try {
        value = parseValue(type!, JSON.parse(line) as Raw);
      } catch {
        value = null;
      }
    }
    return { id: id!, parentId: parentId ?? null, value };
  }
  // Unusual key order (or the header line): parse fully.
  let raw: Raw;
  try {
    raw = JSON.parse(line) as Raw;
  } catch {
    return null; // partial last line while pi is writing
  }
  if (typeof raw.id !== "string" || typeof raw.type !== "string" || raw.type === "session") return null;
  return { id: raw.id, parentId: typeof raw.parentId === "string" ? raw.parentId : null, value: parseValue(raw.type, raw) };
}

/** Extract the searchable text of a pi session file's content. Pure; exported for tests. */
export function parsePiSessionText(content: string): SessionText {
  const entries: Entry[] = [];
  const byId = new Map<string, Entry>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    entries.push(entry);
    byId.set(entry.id, entry);
  }
  // Active branch: from the last entry back to the root. Fall back to file order if broken.
  let branch: Entry[] = [];
  const seen = new Set<string>();
  for (let e = entries[entries.length - 1]; e && !seen.has(e.id); e = e.parentId ? byId.get(e.parentId) : undefined) {
    seen.add(e.id);
    branch.push(e);
    if (e.parentId && !byId.has(e.parentId)) {
      branch = [...entries].reverse();
      break;
    }
  }
  branch.reverse();
  let name: string | null = null;
  const messages: SessionTextMessage[] = [];
  for (const e of branch) {
    if (e.value?.kind === "name") name = e.value.name;
    else if (e.value?.kind === "message") messages.push(e.value.message);
  }
  return { name, messages };
}

export const piSessionReader: SessionTextReader = {
  async stat(sessionRef: string): Promise<SessionFileStat | null> {
    try {
      const s = await stat(sessionRef);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  },
  async read(sessionRef: string): Promise<SessionText | null> {
    let content: string;
    try {
      content = await readFile(sessionRef, "utf8");
    } catch {
      return null;
    }
    return parsePiSessionText(content);
  },
};
