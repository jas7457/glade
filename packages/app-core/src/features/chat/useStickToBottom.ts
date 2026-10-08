/**
 * Keeps a scroll container pinned to the bottom while its content grows (streaming), unless
 * the user has scrolled up. Returns whether we're at the bottom and a function to jump there,
 * plus `scrollToElement` (puts an element's start near the top and stops following the bottom;
 * search hits and bookmarks, I-093 / I-206).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { RefObject } from "preact";
import { jumpScrollTop } from "./jump-to-message";

const THRESHOLD = 48;

export function useStickToBottom(scrollRef: RefObject<HTMLElement>, contentRef: RefObject<HTMLElement>) {
  const [atBottom, setAtBottom] = useState(true);
  const stuck = useRef(true);
  /** Ignore scroll events we caused ourselves. */
  const programmatic = useRef(false);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const el = scrollRef.current;
      if (!el) return;
      stuck.current = true;
      setAtBottom(true);
      programmatic.current = true;
      if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior });
      else el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => (programmatic.current = false));
    },
    [scrollRef],
  );

  /**
   * Put `target`'s start (inside the scroll container) near the top, below `topInset` px of
   * anything overlaying the container's top ({@link jumpScrollTop}), and unstick from the bottom.
   */
  const scrollToElement = useCallback(
    (target: HTMLElement, { behavior = "auto", topInset = 0 }: { behavior?: ScrollBehavior; topInset?: number } = {}) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const next = jumpScrollTop(top, el.clientHeight, el.scrollHeight, { topInset });
      const bottom = el.scrollHeight - next - el.clientHeight <= THRESHOLD;
      stuck.current = bottom;
      setAtBottom(bottom);
      programmatic.current = true;
      if (typeof el.scrollTo === "function") el.scrollTo({ top: next, behavior });
      else el.scrollTop = next;
      requestAnimationFrame(() => (programmatic.current = false));
    },
    [scrollRef],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const bottom = distance <= THRESHOLD;
      if (programmatic.current && !bottom) return;
      stuck.current = bottom;
      setAtBottom(bottom);
    };
    // A wheel/touch gesture upwards always unsticks immediately (even mid-stream).
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        programmatic.current = false;
        stuck.current = false;
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, [scrollRef]);

  // Follow content growth while stuck.
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stuck.current) {
        programmatic.current = true;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => (programmatic.current = false));
      }
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollRef, contentRef]);

  // Start at the bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [scrollRef]);

  return { atBottom, scrollToBottom, scrollToElement };
}
