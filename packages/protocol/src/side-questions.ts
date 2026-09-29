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

/**
 * One follow-up in a side question's thread (I-156): asked with the card's earlier questions and
 * answers plus the chat, answered like the first one. Its own id drives its `side_*` events.
 */
export interface SideQuestionTurn {
  id: string;
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
  /** The answer only saw part of the chat (it was too long to send whole; I-156). */
  partialContext?: boolean;
}

/**
 * A side question and its answer, shown as a "Side question" card in the transcript. The card's
 * own fields are its first question; follow-ups asked in the card (I-156) are in `followUps`.
 */
export interface SideQuestionMessage extends SideQuestionTurn {
  role: "side";
  /** Dismissed by the user: kept in the store, not shown. */
  dismissed?: boolean;
  /** Follow-up questions asked in the same card, oldest first (I-156). */
  followUps?: SideQuestionTurn[];
}

/** The card's questions and answers in order: the first one, then its follow-ups (I-156). */
export function sideQuestionTurns(message: SideQuestionMessage): SideQuestionTurn[] {
  const { role: _role, dismissed: _dismissed, followUps, ...first } = message;
  return [first, ...(followUps ?? [])];
}

/** The newest question of the card (the one Stop, the spinner and Reply are about). */
export function latestSideQuestionTurn(message: SideQuestionMessage): SideQuestionTurn {
  return message.followUps?.at(-1) ?? message;
}

/** Whether any question of the card is still being answered. */
export function sideQuestionStreaming(message: SideQuestionMessage): boolean {
  return message.status === "streaming" || (message.followUps ?? []).some((f) => f.status === "streaming");
}

/** `POST /api/sessions/:id/side-questions`. */
export interface SideQuestionRequest {
  question: string;
  /**
   * Ask it as a follow-up in this card (a {@link SideQuestionMessage} id; I-156): answered with the
   * card's earlier questions and answers, and appended to the same card.
   */
  parentId?: string;
}

/** Answer to {@link SideQuestionRequest}: sent once it started; the answer arrives as `side_*` events. */
export interface SideQuestionResponse {
  /** Id of the {@link SideQuestionMessage} / `side_*` events. */
  id: string;
}

/**
 * The text "Tell the agent" puts in the composer and "Add to queue" sends: the card's questions
 * and their answers (the whole thread, I-156), so the agent gets the context it never saw.
 * Questions without an answer (failed or stopped early) are left out.
 */
export function sideQuestionNote(message: Pick<SideQuestionMessage, "question" | "answer" | "followUps">): string {
  const turns = [message, ...(message.followUps ?? [])]
    .map((t) => ({ question: t.question.trim(), answer: t.answer.trim() }))
    .filter((t) => t.answer);
  if (turns.length === 0) return message.question.trim();
  if (turns.length === 1) return `About my side question "${turns[0]!.question}":\n\n${turns[0]!.answer}`;
  return `About my side questions:\n\n${turns.map((t) => `**Q:** ${t.question}\n\n${t.answer}`).join("\n\n")}`;
}

/** Limits of the serialized context sent with a side question. */
export const SIDE_QUESTION_LIMITS = {
  /** Characters of conversation sent in all (~25k tokens). */
  contextChars: 100_000,
  /**
   * When the conversation is longer (I-156): characters kept of its start (what the chat is about),
   * and of the user's own messages from the part in between (each cut to `middleUserChars`); the
   * rest goes to the newest part.
   */
  headChars: 15_000,
  middleChars: 15_000,
  middleUserChars: 600,
  /** Characters of the card's earlier questions and answers sent with a follow-up (newest kept). */
  threadChars: 20_000,
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
  "A long conversation is shortened: you get its start, the user's messages from the middle, and the most recent part;",
  "when the answer may be in an omitted part, say that you only saw part of the chat rather than claiming it isn't there.",
  "A follow-up comes with the earlier side questions and answers of the same thread.",
  "The agent will not see your answer. Be concise and direct; use markdown sparingly.",
].join(" ");

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} more characters]`;
}

function userText(m: ChatMessage): string {
  return m.role === "user" ? m.content.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n").trim() : "";
}

function describeSide(m: SideQuestionMessage): string | null {
  if (m.dismissed) return null;
  const lines = sideQuestionTurns(m)
    .filter((turn) => turn.status !== "streaming")
    .map((turn) => `SIDE QUESTION (not seen by the agent): ${turn.question}\nSIDE ANSWER: ${turn.answer.trim() || "(none)"}`);
  return lines.length ? lines.join("\n") : null;
}

function describeMessage(m: ChatMessage, t: Transcript, isLastTurn: boolean): string | null {
  switch (m.role) {
    case "user": {
      const text = userText(m);
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
      return describeSide(m);
  }
}

export interface SideQuestionPromptOptions {
  /** Ask as a follow-up in this card: its earlier questions and answers go with it (I-156). */
  threadId?: string;
  /** Characters of conversation sent (default {@link SIDE_QUESTION_LIMITS}`.contextChars`). */
  maxChars?: number;
}

export interface SideQuestionPrompt {
  prompt: string;
  /** Part of the conversation was left out (it was too long). */
  partial: boolean;
}

interface Block {
  text: string;
  /** The user's text, for the middle of a long conversation. */
  user?: string;
}

/** Newest-first fill: the blocks (from the end) that fit in `budget` characters. */
function fillFromEnd(texts: readonly string[], budget: number): string[] {
  const kept: string[] = [];
  let size = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i]!;
    if (size + text.length > budget) {
      if (kept.length === 0 && budget > 0) kept.unshift(text.slice(text.length - budget));
      break;
    }
    kept.unshift(text);
    size += text.length + 2;
  }
  return kept;
}

/**
 * The conversation as plain text within `max` characters. A longer one keeps its start, the user's
 * messages from the part in between (cut), and the newest part (I-156: the tail alone missed what
 * the chat was about).
 */
function serializeConversation(blocks: readonly Block[], max: number): { text: string; partial: boolean } {
  const total = blocks.reduce((n, b) => n + b.text.length + 2, 0);
  if (total <= max) return { text: blocks.map((b) => b.text).join("\n\n"), partial: false };
  const L = SIDE_QUESTION_LIMITS;
  const headBudget = Math.min(L.headChars, Math.floor(max / 4));
  const middleBudget = Math.min(L.middleChars, Math.floor(max / 4));
  // The start: whole blocks while they fit (the first one cut when it alone is too long).
  const head: string[] = [];
  let headSize = 0;
  let h = 0;
  for (; h < blocks.length; h++) {
    const text = blocks[h]!.text;
    if (headSize + text.length > headBudget) {
      if (h === 0) {
        head.push(cut(text, headBudget));
        headSize = headBudget;
        h = 1;
      }
      break;
    }
    head.push(text);
    headSize += text.length + 2;
  }
  // The newest part: whatever is left of the budget after the start and a (possible) middle.
  const tailBudget = max - headSize - middleBudget;
  const rest = blocks.slice(h);
  const tail = fillFromEnd(
    rest.map((b) => b.text),
    tailBudget,
  );
  const omitted = rest.slice(0, rest.length - tail.length);
  const middleUsers = omitted.filter((b) => b.user).map((b) => `USER:\n${cut(b.user!, L.middleUserChars)}`);
  const middle = fillFromEnd(middleUsers, middleBudget);
  const marker = middle.length
    ? `[… ${omitted.length} earlier messages omitted; the user's messages from that part (${middle.length < middleUsers.length ? "the newest, " : ""}cut):]`
    : `[… ${omitted.length} earlier messages omitted …]`;
  const parts = [...head, marker, ...middle, ...(middle.length ? ["[… end of the omitted part; the most recent conversation follows …]"] : []), ...tail];
  return { text: parts.join("\n\n"), partial: true };
}

/**
 * The prompt of a side question: the conversation so far as plain text (a long one shortened, see
 * {@link serializeConversation}; tool outputs and arguments cut), for a follow-up the card's earlier
 * questions and answers, then the question. Harness-neutral: built from Glade's transcript, so every
 * harness answers from the same context.
 */
export function sideQuestionPrompt(transcript: Transcript, question: string, options: SideQuestionPromptOptions = {}): SideQuestionPrompt {
  const lastUser = transcript.messages.findLastIndex((m) => m.role === "user");
  const blocks: Block[] = [];
  let thread: SideQuestionMessage | undefined;
  transcript.messages.forEach((m, i) => {
    if (m.role === "side" && m.id === options.threadId) {
      thread = m;
      return;
    }
    const text = describeMessage(m, transcript, i >= lastUser);
    if (text) blocks.push({ text, ...(m.role === "user" ? { user: userText(m) } : {}) });
  });
  const { text, partial } = blocks.length
    ? serializeConversation(blocks, options.maxChars ?? SIDE_QUESTION_LIMITS.contextChars)
    : { text: "(The conversation is empty so far.)", partial: false };
  let prompt = `<conversation>\n${text}\n</conversation>\n\n`;
  if (thread) {
    const turns = sideQuestionTurns(thread)
      .filter((turn) => turn.status !== "streaming")
      .map((turn) => `SIDE QUESTION: ${turn.question}\nSIDE ANSWER: ${turn.answer.trim() || "(none)"}`);
    const kept = fillFromEnd(turns, SIDE_QUESTION_LIMITS.threadChars);
    if (kept.length) {
      const omitted = kept.length < turns.length ? "[… earlier questions of this thread omitted …]\n\n" : "";
      prompt += `<side_thread>\nEarlier in this side thread (the agent didn't see it either):\n\n${omitted}${kept.join("\n\n")}\n</side_thread>\n\nFollow-up side question: ${question.trim()}`;
      return { prompt, partial };
    }
  }
  return { prompt: `${prompt}Side question: ${question.trim()}`, partial };
}

/** {@link sideQuestionPrompt}'s text only. */
export function buildSideQuestionPrompt(transcript: Transcript, question: string, maxChars: number = SIDE_QUESTION_LIMITS.contextChars): string {
  return sideQuestionPrompt(transcript, question, { maxChars }).prompt;
}
