/**
 * The texts the agent API (I-037) delivers to sessions as prompts, and a parser for them (I-075).
 *
 *   [agent-teams] message from <sender>:\n<text>
 *   [agent-teams] <sender> finished:\n<summary>[\n\n(<note about the still-open sub-agent>)]
 *   [agent-teams] <sender> exited:\n<reason>
 *
 * `<sender>` is `Leo (t3-research)`: the agent's fun display name and its code name (I-120), so
 * the model calls it by the name the user sees; `main` or a bare code name when there's no
 * display name (and in transcripts from before I-120, which still parse).
 *
 * The server builds them with the formatters below; the web recognizes them with
 * {@link parseAgentMessage} (live and from history, where the harness stores the same text) and
 * shows them as a sub-agent report card instead of the user's own message. Harness-neutral: the
 * format is Glade's own.
 */

export type AgentMessageKind = "finished" | "message" | "exited";

export interface AgentMessage {
  kind: AgentMessageKind;
  /** The sending agent's code name (`main` for a message from the parent). */
  from: string;
  /** Its fun display name, when the header carries one (I-120). */
  displayName?: string;
  /** The message / summary / reason, without the header line and trailing note. */
  body: string;
  /** `finished` only: the note about the sub-agent still being open (without parentheses). */
  note?: string;
}

const PREFIX = "[agent-teams] ";

/** How an agent is named to a model (I-120): `Leo (t3-research)`, or just the code name. */
export function agentLabel(name: string, displayName?: string | null): string {
  const display = displayName?.trim();
  return display && display !== name ? `${display} (${name})` : name;
}

/** Prompt text delivered to a session: a message from another agent. */
export function formatAgentMessage(from: string, text: string, displayName?: string | null): string {
  return `${PREFIX}message from ${agentLabel(from, displayName)}:\n${text}`;
}

/** Prompt text delivered to the parent when a sub-agent reports; `note` from {@link agentOpenNote}. */
export function formatAgentFinished(name: string, summary: string, note = "", displayName?: string | null): string {
  return `${PREFIX}${agentLabel(name, displayName)} finished:\n${summary}${note}`;
}

/** Prompt text delivered to the parent when a sub-agent stopped without reporting. */
export function formatAgentExited(name: string, reason: string, displayName?: string | null): string {
  return `${PREFIX}${agentLabel(name, displayName)} exited:\n${reason}`;
}

export interface OpenNoteOptions {
  name: string;
  /** Its fun display name (I-120): the note then says `Leo (t3-research)`. */
  displayName?: string | null;
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
  const who = agentLabel(o.name, o.displayName);
  if (o.userEngaged) return `\n\n(${who}'s tab stays open because the user has typed in it. Leave it to the user.)`;
  return (
    `\n\n(${who} is still open${o.keepOpenReason ? ` — kept open for: ${o.keepOpenReason}` : ""}. ` +
    `If that follow-up is still planned, send it now with message_agent. Otherwise call close_agent. ` +
    `It closes automatically after ${o.idleMinutes} idle minutes.)`
  );
}

/** `Leo (t3-research)` (display name may contain spaces, e.g. "Leo 2") or a bare code name. */
const SENDER = String.raw`(?:([^\n()]+?) \((\S+?)\)|(\S+))`;
const HEADER = new RegExp(String.raw`^\[agent-teams\] (?:message from ${SENDER}|${SENDER} (finished|exited)):(?:\n|$)`);

/**
 * Recognizes a delivered agent-API text. Only matches at the very start of the text (a message
 * that merely mentions "[agent-teams]" is the user's own); `null` otherwise.
 */
export function parseAgentMessage(text: string): AgentMessage | null {
  const m = HEADER.exec(text);
  if (!m) return null;
  const rest = text.slice(m[0].length);
  const isMessage = m[7] === undefined;
  const [displayName, code, bare] = isMessage ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
  const from = (code ?? bare)!;
  const sender = displayName !== undefined ? { from, displayName } : { from };
  if (isMessage) return { kind: "message", ...sender, body: rest };
  const kind = m[7] as "finished" | "exited";
  if (kind === "exited") return { kind, ...sender, body: rest };
  const who = displayName !== undefined ? `${displayName} (${from})` : from;
  for (const start of [`\n\n(${who} is still open`, `\n\n(${who}'s tab stays open`]) {
    const at = rest.lastIndexOf(start);
    if (at !== -1 && rest.endsWith(")")) {
      return { kind, ...sender, body: rest.slice(0, at), note: rest.slice(at + 3, -1) };
    }
  }
  return { kind, ...sender, body: rest };
}
