/**
 * Whether ⌘ (Meta) is held right now (I-153): the composer's send button turns into its
 * follow-up form while it is. Tracks keydown/keyup on the window and resets when the window loses
 * focus or is hidden (the keyup may never arrive then, e.g. after ⌘Tab). Only listens while
 * `enabled`, and reads false otherwise.
 */
import { useEffect, useState } from "preact/hooks";

export function useMetaHeld(enabled: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setHeld(false);
      return;
    }
    const onKey = (e: KeyboardEvent) => setHeld(e.key === "Meta" ? e.type === "keydown" : e.metaKey);
    const reset = () => setHeld(false);
    const onVisibility = () => {
      if (document.visibilityState !== "visible") reset();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);
  return enabled && held;
}
