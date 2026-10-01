/**
 * The word being read aloud, for the transcript (I-193): a client that reads replies (the iPhone's
 * voice mode) sets it, and the reply text it points at highlights that range of its markdown
 * (`Markdown`'s `highlight`). Harness-neutral: a message id, the content block's index and a
 * [start, end) range in that block's markdown. Null: nothing is being read.
 */
import { signal } from "@preact/signals";

export interface ReadingHighlight {
  messageId: string;
  /** The text block's index in the message's content. */
  block: number;
  /** [start, end) in the block's markdown. */
  range: [number, number];
}

export const readingHighlight = signal<ReadingHighlight | null>(null);

/** The range to highlight in the text block with the transcript part key `<messageId>:<block>`, or null. */
export function highlightFor(partKey: string, h: ReadingHighlight | null = readingHighlight.value): [number, number] | null {
  return h && partKey === `${h.messageId}:${h.block}` ? h.range : null;
}
