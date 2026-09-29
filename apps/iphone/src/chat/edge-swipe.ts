/**
 * Swipe in from the left screen edge (I-164, doc §5.4): calls `onSwipe` once a touch that
 * started within `EDGE_PX` of the left edge moved right by `DISTANCE_PX`, mostly horizontally.
 * Opens the chat list over the current chat.
 */
import { useEffect, useRef } from "preact/hooks";

export const EDGE_PX = 24;
export const DISTANCE_PX = 60;

export function useLeftEdgeSwipe(onSwipe: () => void, enabled = true) {
  const handler = useRef(onSwipe);
  handler.current = onSwipe;
  useEffect(() => {
    if (!enabled) return;
    let start: { x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t && t.clientX <= EDGE_PX ? { x: t.clientX, y: t.clientY } : null;
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = Math.abs(t.clientY - start.y);
      if (dy > 40 && dy > dx) start = null;
      else if (dx >= DISTANCE_PX && dx > dy * 1.5) {
        start = null;
        handler.current();
      }
    };
    const onEnd = () => (start = null);
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [enabled]);
}
