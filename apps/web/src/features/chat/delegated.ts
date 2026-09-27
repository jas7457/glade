/**
 * What the parent delegated to a sub-agent (I-109), recognized in the sub-agent's own transcript:
 *
 * - the task: the sub-agent's first prompt (the server sends `spawn_agent`'s task as-is; when
 *   the session still knows its task, the message with that text wins);
 * - the parent's later `message_agent` messages, which arrive as
 *   `[agent-teams] message from main:\n…` prompts (protocol/agent-messages.ts).
 *
 * Both render as full-width cards (DelegatedCard.tsx) instead of the user's bubbles; anything the
 * user types into the sub-agent stays a bubble. Pure, so it's easy to test.
 */
import { parseAgentMessage, type ChatMessage, type UserMessage } from "@glade/protocol";

export interface DelegatedMessage {
  kind: "task" | "message";
  /** Markdown body (for messages: without the `[agent-teams]` header). */
  body: string;
}

/** The parent's name in agent messages (MAIN_AGENT on the server). */
const PARENT = "main";

export function userText(message: UserMessage): string {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");
}

/** Id of the message holding a sub-agent's task: the one with `task`'s text, else the first prompt. */
export function taskMessageId(messages: readonly ChatMessage[], task?: string | null): string | null {
  const users = messages.filter((m): m is UserMessage => m.role === "user");
  const wanted = task?.trim();
  if (wanted) {
    const match = users.find((m) => userText(m).trim() === wanted);
    if (match) return match.id;
  }
  const first = users[0];
  return first && !parseAgentMessage(userText(first)) ? first.id : null;
}

/** The message as something the parent delegated, or null for the user's own words. */
export function delegatedMessage(message: UserMessage, taskId: string | null): DelegatedMessage | null {
  const text = userText(message);
  if (message.id === taskId) return { kind: "task", body: text.trim() };
  const agent = parseAgentMessage(text);
  if (agent?.kind === "message" && agent.from === PARENT) return { kind: "message", body: agent.body.trim() };
  return null;
}
