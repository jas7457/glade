/**
 * The word being read, for the chat behind the voice view (I-193): from the conversation's state
 * to app-core's `readingHighlight` (message id, text block, markdown range), so the transcript
 * highlights it too, and still shows where reading is when the voice view is minimized.
 */
import type { ReadingHighlight } from "@glade/app-core/state/reading-highlight";
import type { VoiceState } from "./machine";
import { chatRange } from "./speakable";

export function chatHighlightOf(state: VoiceState): ReadingHighlight | null {
  const r = state.reading;
  if (state.phase.name !== "speaking" || !r?.word || r.silenced) return null;
  const hit = chatRange(r.speech, r.word[0], r.word[1]);
  if (!hit) return null;
  const colon = hit.at.lastIndexOf(":");
  const block = Number(hit.at.slice(colon + 1));
  if (colon < 0 || !Number.isInteger(block)) return null;
  return { messageId: hit.at.slice(0, colon), block, range: hit.range };
}

/** Same highlight (no need to publish it again). */
export function sameHighlight(a: ReadingHighlight | null, b: ReadingHighlight | null): boolean {
  if (!a || !b) return a === b;
  return a.messageId === b.messageId && a.block === b.block && a.range[0] === b.range[0] && a.range[1] === b.range[1];
}
