/**
 * Smooth reveal of streamed assistant text (I-072). Providers often send a short reply in one or
 * two big deltas, so it pops in whole. `useSmoothText` shows the growing text through a small
 * buffer that drains each new backlog linearly over ~DRAIN_MS, advancing once per animation
 * frame (and committing at most every MIN_COMMIT_MS so Markdown isn't re-rendered too often).
 *
 *   - Never streamed while mounted (history): the full text, immediately.
 *   - The message stops streaming mid-reveal: the reveal finishes (at most DRAIN_MS more), so a
 *     short reply that arrives in one delta right before the end still streams in.
 *   - The pure part (`retarget`, `advance`, `revealedText`) is tested on its own.
 */
import { useEffect, useRef, useState } from "preact/hooks";

/** Each new backlog is revealed over this long. */
export const DRAIN_MS = 200;
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

/** The text grew (or was replaced): drain the new backlog in `drainMs` from now. */
export function retarget(state: RevealState, target: number, drainMs = DRAIN_MS): RevealState {
  const shown = Math.min(state.shown, target);
  const backlog = target - shown;
  return { shown, target, rate: backlog > 0 ? backlog / drainMs : 0 };
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
    streaming ? retarget({ shown: 0, target: 0, rate: 0 }, text.length) : { shown: text.length, target: text.length, rate: 0 },
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
