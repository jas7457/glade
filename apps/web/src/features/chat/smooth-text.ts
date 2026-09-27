/**
 * Smooth reveal of streamed assistant text (I-072, I-079). Providers often send text in big
 * bursts: a short reply in one or two deltas, and with thinking models (e.g. Opus with adaptive
 * thinking) the first ~2000 characters of a reply arrive within a few ms after a silent thinking
 * phase, then the rest streams at ~250 chars/s. `useSmoothText` shows the growing text through a
 * buffer that drains each new backlog linearly, advancing once per animation frame (and
 * committing at most every MIN_COMMIT_MS so Markdown isn't re-rendered too often). The drain
 * time grows with the backlog (REVEAL_CHARS_PER_MS, between DRAIN_MS and MAX_DRAIN_MS), so a
 * burst is paced out instead of popping in within DRAIN_MS.
 *
 *   - Never streamed while mounted (history): the full text, immediately.
 *   - Mounted mid-stream (e.g. switching to a chat that is replying): the text already there is
 *     caught up within DRAIN_MS; only growth after that is paced.
 *   - The message stops streaming mid-reveal: the reveal finishes (at most MAX_DRAIN_MS more), so
 *     a reply that arrives in one burst right before the end still streams in.
 *   - The pure part (`retarget`, `advance`, `revealedText`) is tested on its own.
 */
import { useEffect, useRef, useState } from "preact/hooks";

/** A new backlog is revealed over at least this long. */
export const DRAIN_MS = 200;
/** Reveal speed for big backlogs (characters per ms), so a burst still reads as streaming. */
export const REVEAL_CHARS_PER_MS = 1;
/** ...but never lag more than this far behind (long bursts reveal faster). */
export const MAX_DRAIN_MS = 2500;
/** At most one re-render per this many ms (~30 fps) while draining. */
export const MIN_COMMIT_MS = 32;

export interface RevealState {
  /** Characters revealed (fractional; rendered floored). */
  shown: number;
  /** Length of the text we're revealing towards. */
  target: number;
  /** Characters per ms for the current backlog. */
  rate: number;
}

/** How long to take for a backlog of `chars`: paced at REVEAL_CHARS_PER_MS, within [DRAIN_MS, MAX_DRAIN_MS]. */
export function drainTime(chars: number): number {
  return Math.min(MAX_DRAIN_MS, Math.max(DRAIN_MS, chars / REVEAL_CHARS_PER_MS));
}

/** The text grew (or was replaced): drain the new backlog in `drainMs` (default: paced) from now. */
export function retarget(state: RevealState, target: number, drainMs?: number): RevealState {
  const shown = Math.min(state.shown, target);
  const backlog = target - shown;
  return { shown, target, rate: backlog > 0 ? backlog / (drainMs ?? drainTime(backlog)) : 0 };
}

/** Advance by `dt` ms of animation. */
export function advance(state: RevealState, dt: number): RevealState {
  if (state.shown >= state.target) return state;
  return { ...state, shown: Math.min(state.target, state.shown + state.rate * Math.max(0, dt)) };
}

/** The first `shown` characters of `text`, never splitting a surrogate pair. */
export function revealedText(text: string, shown: number): string {
  let cut = Math.max(0, Math.min(text.length, Math.floor(shown)));
  if (cut > 0 && cut < text.length) {
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut++;
  }
  return cut >= text.length ? text : text.slice(0, cut);
}

export function useSmoothText(text: string, streaming: boolean): string {
  const ref = useRef<RevealState>(
    streaming ? retarget({ shown: 0, target: 0, rate: 0 }, text.length, DRAIN_MS) : { shown: text.length, target: text.length, rate: 0 },
  );
  const [, setFrame] = useState(0);
  // Live once it has streamed while mounted; history (never live) shows in full at once.
  const live = useRef(streaming);
  if (streaming) live.current = true;

  if (!live.current) ref.current = { shown: text.length, target: text.length, rate: 0 };
  else if (ref.current.target !== text.length) ref.current = retarget(ref.current, text.length);

  useEffect(() => {
    if (!live.current || ref.current.shown >= ref.current.target) return;
    let raf = 0;
    let last = performance.now();
    let lastCommit = last;
    let committed = Math.floor(ref.current.shown);
    const frame = (t: number) => {
      ref.current = advance(ref.current, t - last);
      last = t;
      const done = ref.current.shown >= ref.current.target;
      const shown = Math.floor(ref.current.shown);
      if (shown !== committed && (done || t - lastCommit >= MIN_COMMIT_MS)) {
        committed = shown;
        lastCommit = t;
        setFrame((n) => n + 1);
      }
      if (!done) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [streaming, text]);

  return live.current ? revealedText(text, ref.current.shown) : text;
}
