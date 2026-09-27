/**
 * Chat titles from a one-shot completion (I-067): the prompt and the cleanup of the reply.
 * Harnesses without their own `generateTitle` get titles through `AgentHarness.complete`.
 * The same prompt names a new chat (from its first message) and `/name` without a title (from
 * a conversation excerpt, I-074).
 *
 *   const reply = await harness.complete({ prompt: titlePrompt(firstMessage), model, cwd });
 *   const title = cleanTitle(reply); // null when empty
 *   // or simply: await generateTitleWith(harness, { firstMessage, cwd, model })
 *   // a whole conversation: { firstMessage, excerpt: conversationExcerpt(messages), cwd, model }
 */
import { parseAgentMessage } from "@glade/protocol";
import type { AgentHarness, GenerateTitleOptions, SessionTextMessage } from "./types.js";

const TITLE_RULES = "Reply with the title only: no quotes, no trailing punctuation.";

/** The title prompt: from the first message, or from a conversation excerpt when given. */
export function titlePrompt(firstMessage: string, excerpt?: string): string {
  if (excerpt) {
    return (
      "Write a short title (max 6 words) for the conversation below: what it is about and what it works on now. " +
      TITLE_RULES +
      "\n\n<conversation>\n" +
      excerpt +
      "\n</conversation>"
    );
  }
  return (
    "Write a short title (max 6 words) for a conversation that starts with the message below. " +
    TITLE_RULES +
    "\n\n<message>\n" +
    firstMessage.slice(0, 2000) +
    "\n</message>"
  );
}

/** Excerpt limits: total characters, per message, and how many recent messages are included. */
export const EXCERPT_MAX_CHARS = 4000;
const EXCERPT_FIRST_CHARS = 1200;
const EXCERPT_MESSAGE_CHARS = 700;
const EXCERPT_RECENT = 6;

type ExcerptMessage = Pick<SessionTextMessage, "role" | "text">;

/**
 * A compact excerpt of a conversation for titling it: the first user message plus the latest few
 * user/assistant texts (tool output and thinking are not in `messages`), each shortened, capped
 * at {@link EXCERPT_MAX_CHARS}. `""` when there's no text. Sub-agent reports/messages delivered as
 * prompts aren't the user's words (I-100): they never count as the first message and are labelled
 * `Agent <name>` instead of `User`.
 */
export function conversationExcerpt(messages: readonly ExcerptMessage[], maxChars = EXCERPT_MAX_CHARS): string {
  const texts = messages
    .map((m) => ({ role: m.role, text: m.text.trim(), agent: m.role === "user" ? parseAgentMessage(m.text.trim()) : null }))
    .filter((m) => m.text);
  const firstIndex = texts.findIndex((m) => m.role === "user" && !m.agent);
  if (firstIndex < 0) return "";
  const line = (m: (typeof texts)[number], max: number) => {
    const who = m.agent ? `Agent ${m.agent.from}` : m.role === "user" ? "User" : "Assistant";
    const text = m.agent ? m.agent.body.trim() : m.text;
    return `${who}: ${text.length > max ? `${text.slice(0, max)}…` : text}`;
  };
  const first = line(texts[firstIndex]!, EXCERPT_FIRST_CHARS);
  let budget = maxChars - first.length;
  const recent: string[] = [];
  const start = Math.max(firstIndex + 1, texts.length - EXCERPT_RECENT);
  for (let i = texts.length - 1; i >= start; i--) {
    const entry = line(texts[i]!, EXCERPT_MESSAGE_CHARS);
    if (entry.length + 2 > budget) break;
    recent.unshift(entry);
    budget -= entry.length + 2;
  }
  const skipped = texts.length - 1 - firstIndex - recent.length > 0;
  return [first, ...(skipped ? ["[…]"] : []), ...recent].join("\n\n").slice(0, maxChars);
}

/** First non-empty line, without quotes/markdown/trailing punctuation, max 80 chars. */
export function cleanTitle(reply: string | null): string | null {
  const title = (reply ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean)
    ?.replace(/^["'#*\s]+|["'*.\s]+$/g, "")
    .slice(0, 80);
  return title || null;
}

/**
 * A title from `harness.generateTitle` when it has one, else from a one-shot `complete`.
 * `null` when the harness can do neither (or failed).
 */
export async function generateTitleWith(harness: AgentHarness, options: GenerateTitleOptions): Promise<string | null> {
  if (harness.generateTitle) return harness.generateTitle(options);
  if (!harness.complete) return null;
  const reply = await harness.complete({ prompt: titlePrompt(options.firstMessage, options.excerpt), model: options.model, cwd: options.cwd });
  return cleanTitle(reply);
}

/** Whether {@link generateTitleWith} can produce titles with this harness. */
export function canGenerateTitles(harness: AgentHarness): boolean {
  return !!(harness.generateTitle || harness.complete);
}
