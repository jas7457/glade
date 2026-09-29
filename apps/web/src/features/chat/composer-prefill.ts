/**
 * Putting text into a chat's composer from elsewhere (the side question card's "Tell the Agent",
 * I-140). The composer of that chat picks the request up, adds the text to its draft (after what's
 * already typed) and focuses the box.
 */
import { signal } from "@preact/signals";

export interface ComposerPrefill {
  /** The composer's draft key (`chat:<sessionId>`). */
  draftKey: string;
  text: string;
  /** Tells repeated requests with the same text apart. */
  nonce: number;
}

export const composerPrefill = signal<ComposerPrefill | null>(null);

let nonce = 0;

/** Add `text` to the composer of session `chatId` and focus it. */
export function prefillComposer(chatId: string, text: string): void {
  composerPrefill.value = { draftKey: `chat:${chatId}`, text, nonce: ++nonce };
}

/** The draft after adding `text` to what's typed (a blank line between). */
export function withPrefill(current: string, text: string): string {
  return current.trim() ? `${current.replace(/\s+$/, "")}\n\n${text}` : text;
}
