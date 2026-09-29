/**
 * Side questions (`/btw`, the composer's Ask Aside button; I-140): a one-off question about the
 * chat, answered by a separate short model call over the conversation so far (including a turn
 * still in progress). No tools, no file edits. The main run is untouched and the agent never sees
 * the question or the answer: the card is stored with the chat in Glade's store only.
 *
 * Flow: `POST /sessions/:id/side-questions` → `side_start`, `side_delta`s, `side_end` events fold
 * into a {@link SideQuestionMessage}; Stop = `POST …/side-questions/:qid/stop`, Dismiss =
 * `POST …/side-questions/:qid/dismiss` (`side_dismiss`: the card stays stored but hidden).
 */
import type { ChatMessage, Transcript } from "./transcript.js";

export type SideQuestionStatus = "streaming" | "done" | "stopped" | "error";

/** A side question and its answer, shown as a "Side question" card in the transcript. */
export interface SideQuestionMessage {
  id: string;
  role: "side";
  question: string;
  /** The answer so far (markdown; streams while `status` is `streaming`). */
  answer: string;
  status: SideQuestionStatus;
  /** Why it failed (`status: "error"`). */
  error?: string;
  /** The model that answers (`provider/id`), when known. */
  model?: string;
  /** Asked at (epoch ms). */
  timestamp: number;
  /** Finished at (epoch ms). */
  endedAt?: number;
  /** Dismissed by the user: kept in the store, not shown. */
  dismissed?: boolean;
}

/** `POST /api/sessions/:id/side-questions`. */
export interface SideQuestionRequest {
  question: string;
}

/** Answer to {@link SideQuestionRequest}: sent once it started; the answer arrives as `side_*` events. */
export interface SideQuestionResponse {
  /** Id of the {@link SideQuestionMessage} / `side_*` events. */
  id: string;
}

/**
 * The text "Tell the agent" puts in the composer and "Add to queue" sends: the question and its
 * answer, so the agent gets the context it never saw.
 */
export function sideQuestionNote(message: Pick<SideQuestionMessage, "question" | "answer">): string {
  const answer = message.answer.trim();
  return answer ? `About my side question "${message.question.trim()}":\n\n${answer}` : message.question.trim();
}

/** Limits of the serialized context sent with a side question. */
export const SIDE_QUESTION_LIMITS = {
  /** Characters of conversation kept (the newest; older turns are cut first). */
  contextChars: 60_000,
  /** Characters kept of one tool output. */
  toolOutputChars: 1_500,
  /** Characters kept of one tool call's arguments. */
  toolArgsChars: 600,
  /** Characters kept of one message's thinking (only the running turn's). */
  thinkingChars: 1_500,
} as const;

export const SIDE_QUESTION_SYSTEM_PROMPT = [
  "You answer a quick side question the user asks about an ongoing conversation between them and a coding agent.",
  "The agent may still be working; its latest turn can be incomplete. You can't use tools, read files or run commands:",
  "answer only from the conversation below, and say so briefly when it doesn't contain the answer.",
  "The agent will not see your answer. Be concise and direct; use markdown sparingly.",
].join(" ");

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

function describeMessage(m: ChatMessage, t: Transcript, isLastTurn: boolean): string | null {
  switch (m.role) {
    case "user": {
      const text = m.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n").trim();
      return text ? `USER:\n${text}` : null;
    }
    case "assistant": {
      const parts: string[] = [];
      for (const block of m.content) {
        if (block.type === "text" && block.text.trim()) parts.push(block.text.trim());
        else if (block.type === "thinking" && isLastTurn && !block.redacted && block.text.trim()) {
          parts.push(`(thinking) ${cut(block.text.trim(), SIDE_QUESTION_LIMITS.thinkingChars)}`);
        } else if (block.type === "toolCall") {
          const args = block.args ?? block.input ?? (block.argsText ? { partial: block.argsText } : {});
          const result = t.toolResults[block.id];
          const status = !result ? "pending" : result.status === "running" ? "running" : result.status === "error" ? "failed" : "done";
          let line = `[tool ${block.name} ${cut(JSON.stringify(args), SIDE_QUESTION_LIMITS.toolArgsChars)} → ${status}]`;
          if (result?.output.trim()) line += `\n${cut(result.output.trim(), SIDE_QUESTION_LIMITS.toolOutputChars)}`;
          parts.push(line);
        }
      }
      if (m.errorMessage) parts.push(`[error: ${m.errorMessage}]`);
      if (m.streaming) parts.push("[still writing…]");
      return parts.length ? `AGENT:\n${parts.join("\n\n")}` : null;
    }
    case "notice":
      return m.kind === "compaction" ? `[earlier context was compacted: ${m.text}]` : `[note: ${m.text}]`;
    case "shell":
      return m.shared ? `[user ran \`${m.command}\`]\n${cut(m.output.trim(), SIDE_QUESTION_LIMITS.toolOutputChars)}` : null;
    case "side":
      // Earlier side questions: context for follow-ups (still never seen by the agent).
      if (m.dismissed || m.status === "streaming") return null;
      return `SIDE QUESTION (not seen by the agent): ${m.question}\nSIDE ANSWER: ${m.answer.trim() || "(none)"}`;
  }
}

/**
 * The prompt of a side question: the conversation so far as plain text (newest kept when it's
 * long; tool outputs and arguments cut), then the question. Harness-neutral: built from Glade's
 * transcript, so every harness answers from the same context.
 */
export function buildSideQuestionPrompt(transcript: Transcript, question: string, maxChars: number = SIDE_QUESTION_LIMITS.contextChars): string {
  const lastUser = transcript.messages.findLastIndex((m) => m.role === "user");
  const blocks: string[] = [];
  transcript.messages.forEach((m, i) => {
    const text = describeMessage(m, transcript, i >= lastUser);
    if (text) blocks.push(text);
  });
  const kept: string[] = [];
  let size = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    if (size + block.length > maxChars) {
      if (kept.length === 0) kept.unshift(block.slice(block.length - maxChars));
      kept.unshift("[… earlier conversation omitted …]");
      break;
    }
    kept.unshift(block);
    size += block.length + 2;
  }
  const conversation = kept.length ? kept.join("\n\n") : "(The conversation is empty so far.)";
  return `<conversation>\n${conversation}\n</conversation>\n\nSide question: ${question.trim()}`;
}
