/**
 * Keeping the word being read in view without moving the text on every word (I-181).
 *
 * The reply only scrolls when the current word leaves a comfortable band of the scroll view
 * (by default from 15 % to 65 % of its height). Then it scrolls once so the word's line sits at the
 * top of the band, which leaves room for the next several lines to be read before it moves again.
 */

/** Vertical position of the word relative to the scroll view's visible top, in px. */
export interface WordBox {
  top: number;
  bottom: number;
}

export interface Band {
  /** Fraction of the view height where the band starts / ends. */
  top: number;
  bottom: number;
}

export const FOLLOW_BAND: Band = { top: 0.15, bottom: 0.65 };

/**
 * The scrollTop to move to so `word` is back in the band, or null when it's still inside it (or
 * the scroll can't change anything). `word` is relative to the visible top of the view.
 */
export function followScrollTop(view: { scrollTop: number; clientHeight: number; scrollHeight: number }, word: WordBox, band: Band = FOLLOW_BAND): number | null {
  const h = view.clientHeight;
  if (h <= 0) return null;
  const bandTop = h * band.top;
  const bandBottom = h * band.bottom;
  if (word.top >= bandTop && word.bottom <= bandBottom) return null;
  const max = Math.max(0, view.scrollHeight - h);
  const target = Math.min(max, Math.max(0, Math.round(view.scrollTop + word.top - bandTop)));
  return Math.abs(target - view.scrollTop) < 1 ? null : target;
}
