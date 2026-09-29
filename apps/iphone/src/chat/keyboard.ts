/**
 * Keeps a full-screen view sized to what's visible above the on-screen keyboard (I-164). iOS
 * doesn't shrink the layout viewport when the keyboard opens: it shrinks the *visual* viewport
 * and scrolls the page to reveal the focused field, which pushes the nav bar off screen and
 * makes the composer jump. The chat screen instead pins itself (position: fixed) to the visual
 * viewport's height and undoes the page scroll, so the composer sits right on the keyboard.
 */
import { useEffect, useState } from "preact/hooks";

export interface KeyboardViewport {
  /** Visible height in CSS px (the window's without a keyboard), or null before the first read. */
  height: number | null;
  /** The keyboard (or anything else) covers the bottom of the screen. */
  keyboardOpen: boolean;
}

/** Minimum shrink (px) that counts as a keyboard, not a toolbar or rounding. */
const KEYBOARD_MIN = 120;

export function useKeyboardViewport(): KeyboardViewport {
  const [state, setState] = useState<KeyboardViewport>({ height: null, keyboardOpen: false });
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const height = Math.round(vv.height);
      setState({ height, keyboardOpen: window.innerHeight - height > KEYBOARD_MIN });
      // iOS scrolls the page to reveal the focused field; the view is already above the keyboard.
      if (window.scrollY !== 0 || document.documentElement.scrollTop !== 0) window.scrollTo(0, 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
    };
  }, []);
  return state;
}
