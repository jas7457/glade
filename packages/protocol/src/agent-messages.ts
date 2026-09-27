/**
 * The texts the agent API (I-037) delivers to sessions as prompts, and a parser for them (I-075).
 *
 *   [agent-teams] message from <name>:\n<text>
 *   [agent-teams] <name> finished:\n<summary>[\n\n(<note about the still-open sub-agent>)]
 *   [agent-teams] <name> exited:\n<reason>
 *
 * The server builds them with the formatters below; the web recognizes them with
 * {@link parseAgentMessage} (live and from history, where the harness stores the same text) and
 * shows them as a sub-agent report card instead of the user's own message. Harness-neutral: the
 * format is Glade's own.
 */

export type AgentMessageKind = "finished" | "message" | "exited";

export interface AgentMessage {
  kind: AgentMessageKind;
  /** The sending agent's name (`main` for a message from the parent). */
  from: string;
  /** The message / summary / reason, without the header line and trailing note. */
  body: string;
  /** `finished` only: the note about the sub-agent still being open (without parentheses). */
  note?: string;
}

const PREFIX = "[agent-teams] ";

/** Prompt text delivered to a session: a message from another agent. */
export function formatAgentMessage(from: string, text: string): string {
  return `${PREFIX}message from ${from}:\n${text}`;
}

/** Prompt text delivered to the parent when a sub-agent reports; `note` from {@link agentOpenNote}. */
export function formatAgentFinished(name: string, summary: string, note = ""): string {
  return `${PREFIX}${name} finished:\n${summary}${note}`;
}

/** Prompt text delivered to the parent when a sub-agent stopped without reporting. */
export function formatAgentExited(name: string, reason: string): string {
  return `${PREFIX}${name} exited:\n${reason}`;
}

export interface OpenNoteOptions {
  name: string;
  /** It will stop (or has stopped) anyway: no note. */
  closing: boolean;
  userEngaged: boolean;
  keepOpenReason: string | null;
  /** Idle minutes after which a kept-open sub-agent closes. */
  idleMinutes: number;
}

/** After a result, tell the parent what happens to the sub-agent so it acts on it. */
export function agentOpenNote(o: OpenNoteOptions): string {
  if (o.closing) return "";
  if (o.userEngaged) return `\n\n(${o.name}'s tab stays open because the user has typed in it. Leave it to the user.)`;
  return (
    `\n\n(${o.name} is still open${o.keepOpenReason ? ` — kept open for: ${o.keepOpenReason}` : ""}. ` +
    `If that follow-up is still planned, send it now with message_agent. Otherwise call close_agent. ` +
    `It closes automatically after ${o.idleMinutes} idle minutes.)`
  );
}

const HEADER = /^\[agent-teams\] (?:message from (\S+)|(\S+) (finished|exited)):(?:\n|$)/;

/**
 * Recognizes a delivered agent-API text. Only matches at the very start of the text (a message
 * that merely mentions "[agent-teams]" is the user's own); `null` otherwise.
 */
export function parseAgentMessage(text: string): AgentMessage | null {
  const m = HEADER.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  if (m[1] !== undefined) return { kind: "message", from: m[1], body: rest };
  const from = m[2]!;
  const kind = m[3] as "finished" | "exited";
  if (kind === "exited") return { kind, from, body: rest };
  for (const start of [`\n\n(${from} is still open`, `\n\n(${from}'s tab stays open`]) {
    const at = rest.lastIndexOf(start);
    if (at !== -1 && rest.endsWith(")")) {
      return { kind, from, body: rest.slice(0, at), note: rest.slice(at + 3, -1) };
    }
  }
  return { kind, from, body: rest };
}
