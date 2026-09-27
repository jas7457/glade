/**
 * Chat titles from a one-shot completion (I-067): the prompt and the cleanup of the reply.
 * Harnesses without their own `generateTitle` get titles through `AgentHarness.complete`.
 *
 *   const reply = await harness.complete({ prompt: titlePrompt(firstMessage), model, cwd });
 *   const title = cleanTitle(reply); // null when empty
 *   // or simply: await generateTitleWith(harness, { firstMessage, cwd, model })
 */
import type { AgentHarness, GenerateTitleOptions } from "./types.js";

export function titlePrompt(firstMessage: string): string {
  return (
    "Write a short title (max 6 words) for a conversation that starts with the message below. " +
    "Reply with the title only: no quotes, no trailing punctuation.\n\n<message>\n" +
    firstMessage.slice(0, 2000) +
    "\n</message>"
  );
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
  const reply = await harness.complete({ prompt: titlePrompt(options.firstMessage), model: options.model, cwd: options.cwd });
  return cleanTitle(reply);
}

/** Whether {@link generateTitleWith} can produce titles with this harness. */
export function canGenerateTitles(harness: AgentHarness): boolean {
  return !!(harness.generateTitle || harness.complete);
}
