/**
 * Prompts and parsing for the fast-model steps of I-046 (pure, unit-tested):
 * - `finderPrompt` / `parseFinderReply`: pick the chats matching a natural-language request among
 *   candidates labelled `c1…cN` (labels keep the reply short and stop the model inventing ids).
 * - `summaryPrompt` / `cleanSummary`: a one-line summary of a conversation.
 */
import { isAgentMessage } from "./agent-text.js";
import type { SessionTextMessage } from "./types.js";

export interface FinderCandidate {
  /** Opaque label shown to the model, e.g. "c3". */
  label: string;
  title: string;
  project: string | null;
  updatedAt: number;
  summary: string | null;
  /** First user message (short), used when there's no summary. */
  opening: string | null;
  /** Matching passage from the keyword search, if any. */
  excerpt: string | null;
}

export interface FinderReply {
  matches: Array<{ label: string; reason: string }>;
  confident: boolean;
}

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function finderPrompt(request: string, candidates: readonly FinderCandidate[], now = Date.now()): string {
  const lines = candidates.map((c) => {
    const parts = [`${c.label}: "${clip(c.title, 80)}"`, c.project ? `project ${c.project}` : "no project", `last active ${day(c.updatedAt)}`];
    if (c.summary) parts.push(`summary: ${clip(c.summary, 200)}`);
    else if (c.opening) parts.push(`starts with: ${clip(c.opening, 160)}`);
    if (c.excerpt) parts.push(`matching text: ${clip(c.excerpt, 160)}`);
    return parts.join(" | ");
  });
  return [
    "You help a user find one of their past chats with a coding agent.",
    `Today is ${day(now)}. The user asks:`,
    `<request>\n${request.slice(0, 1000)}\n</request>`,
    "Candidate chats:",
    lines.join("\n"),
    "",
    "Pick the chats that best match the request, best first, at most 3. Only include plausible matches.",
    'Reply with JSON only, no prose: {"matches":[{"id":"c1","reason":"max 12 words"}],"confident":true}',
    '"confident" is true only when the first match is clearly the chat meant. If none match, reply {"matches":[],"confident":false}.',
  ].join("\n");
}

/** Parse the model's JSON reply; unknown labels are dropped. `null` if unparseable. */
export function parseFinderReply(reply: string, labels: ReadonlySet<string>): FinderReply | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const raw = (data as { matches?: unknown }).matches;
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const matches: FinderReply["matches"] = [];
  for (const m of raw) {
    const label = typeof m === "string" ? m : typeof m?.id === "string" ? m.id : null;
    if (!label || !labels.has(label) || seen.has(label)) continue;
    seen.add(label);
    matches.push({ label, reason: typeof m?.reason === "string" ? clip(m.reason, 140) : "" });
  }
  return { matches, confident: (data as { confident?: unknown }).confident === true && matches.length > 0 };
}

/**
 * Conversation excerpt for the summary prompt: user messages plus the last reply, within `budget`
 * characters. Sub-agent reports delivered as prompts aren't the user's words and are left out (I-100).
 */
export function summaryPrompt(title: string, messages: readonly SessionTextMessage[], budget = 6000): string {
  const users = messages.filter((m) => m.role === "user" && !isAgentMessage(m));
  const lastReply = [...messages].reverse().find((m) => m.role === "assistant");
  const parts: string[] = [];
  let left = budget;
  for (const m of users) {
    if (left <= 0) break;
    const text = clip(m.text, Math.min(600, left));
    parts.push(`User: ${text}`);
    left -= text.length;
  }
  if (lastReply) parts.push(`Assistant (last reply): ${clip(lastReply.text, 800)}`);
  return [
    "Summarize what this conversation between a user and a coding agent is about in one sentence (max 25 words).",
    "Mention the concrete subject (feature, bug, file, topic). Reply with the sentence only.",
    `<title>${clip(title, 120)}</title>`,
    `<conversation>\n${parts.join("\n")}\n</conversation>`,
  ].join("\n");
}

export function cleanSummary(reply: string | null): string | null {
  const line = reply
    ?.split("\n")
    .map((l) => l.trim())
    .find(Boolean)
    ?.replace(/^["'*\s]+|["'*\s]+$/g, "")
    .replace(/^summary:\s*/i, "");
  return line ? clip(line, 240) : null;
}
