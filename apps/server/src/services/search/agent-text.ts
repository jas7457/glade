/**
 * Sub-agent reports and messages (`[agent-teams] …` prompts, I-037/I-075) aren't the user's words
 * (I-100): search indexes them as `agent` fields, and summaries/the finder skip them when they
 * look for what the user said. Pure.
 */
import { agentLabel, parseAgentMessage } from "@glade/protocol";
import type { SessionTextMessage } from "./types.js";

/** Whether a message is a delivered agent-teams text rather than something the user typed. */
export function isAgentMessage(m: Pick<SessionTextMessage, "role" | "text">): boolean {
  return m.role === "user" && parseAgentMessage(m.text) !== null;
}

/**
 * The text to index for a delivered agent-teams message: its header without the `[agent-teams]`
 * marker ("reviewer finished:", "Leo (reviewer) finished:", "message from main:") and its body, without the trailing note
 * about the sub-agent staying open. `null` when the text isn't one.
 */
export function agentMessageText(text: string): string | null {
  const m = parseAgentMessage(text);
  if (!m) return null;
  const who = agentLabel(m.from, m.displayName);
  const header = m.kind === "message" ? `message from ${who}:` : `${who} ${m.kind}:`;
  return `${header}\n${m.body}`;
}
