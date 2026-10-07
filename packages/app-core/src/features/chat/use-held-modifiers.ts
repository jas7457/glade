/**
 * Which send modifiers are held right now (I-153, I-200): ⌘ (or Ctrl) and ⌥. The composer's Send
 * button shows the mode ↩ would use with them (send-mode.ts).
 *
 * - Tracks keydown/keyup on the window; resets when the window loses focus or is hidden (the keyup
 *   may never arrive then, e.g. after ⌘Tab).
 * - No flicker on quick shortcuts: a newly held modifier shows only after `delayMs`, and a key
 *   pressed with it (⌘K, ⌘C, ⌥e…; not ↩) hides it until every modifier is released. Releasing
 *   shows at once.
 * - Only listens while `enabled`, and reads nothing held otherwise.
 */
import { useEffect, useState } from "preact/hooks";

export interface HeldModifiers {
  /** ⌘ or Ctrl. */
  meta: boolean;
  /** ⌥. */
  alt: boolean;
}

/** How long a modifier must be held before it shows (ms). */
export const MODIFIER_SHOW_DELAY_MS = 120;

const NONE: HeldModifiers = { meta: false, alt: false };
/** Keys that don't make a chord: modifiers, and ↩ (⌘↩ is the follow-up itself). */
const NOT_A_CHORD = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn", "OS", "Enter"]);

export function useHeldModifiers(enabled: boolean, delayMs = MODIFIER_SHOW_DELAY_MS): HeldModifiers {
  const [shown, setShown] = useState<HeldModifiers>(NONE);
  useEffect(() => {
    if (!enabled) {
      setShown(NONE);
      return;
    }
    let down = { meta: false, ctrl: false, alt: false };
    /** A shortcut was typed with a modifier held: show nothing until all are released. */
    let chord = false;
    let current = NONE;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = (next: HeldModifiers) => {
      current = next;
      setShown(next);
    };
    const apply = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const target = chord ? NONE : { meta: down.meta || down.ctrl, alt: down.alt };
      // Released modifiers go at once; newly held ones after the delay.
      const kept = { meta: target.meta && current.meta, alt: target.alt && current.alt };
      if (kept.meta !== current.meta || kept.alt !== current.alt) show(kept);
      if (target.meta !== kept.meta || target.alt !== kept.alt) {
        timer = setTimeout(() => {
          timer = null;
          show(target);
        }, delayMs);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const isDown = e.type === "keydown";
      down = {
        meta: e.key === "Meta" ? isDown : e.metaKey,
        ctrl: e.key === "Control" ? isDown : e.ctrlKey,
        alt: e.key === "Alt" ? isDown : e.altKey,
      };
      if (!down.meta && !down.ctrl && !down.alt) chord = false;
      else if (isDown && !NOT_A_CHORD.has(e.key)) chord = true;
      apply();
    };
    const reset = () => {
      down = { meta: false, ctrl: false, alt: false };
      chord = false;
      apply();
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") reset();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, delayMs]);
  return enabled ? shown : NONE;
}
