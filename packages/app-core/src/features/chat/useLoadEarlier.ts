/**
 * "Load earlier" for a transcript that starts at the newest turns (I-122 snapshots, I-169):
 * scrolling near the top loads the turns before the first loaded message, and when messages are
 * prepended the view keeps its distance from the bottom, so what you were reading stays put
 * (WebKit has no CSS scroll anchoring). The transcript's button stays as a fallback.
 */
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { RefObject } from "preact";
import type { ChatMessage } from "@glade/protocol";
import { loadEarlierMessages, type ChatSessionStore } from "@glade/app-core/state/chat-session";

/** Start loading when the top is this close (px; a screen or so ahead). */
const NEAR_TOP = 600;
const RETRY_MS = 5000;

export function useLoadEarlier(scrollRef: RefObject<HTMLElement>, store: ChatSessionStore, messages: readonly ChatMessage[]): void {
  // Called during render, before the DOM changes: note where we are if messages were prepended.
  const firstId = useRef<string | null>(null);
  const fromBottom = useRef<number | null>(null);
  const first = messages[0]?.id ?? null;
  if (first !== firstId.current) {
    const el = scrollRef.current;
    const prepended = firstId.current !== null && messages.some((m) => m.id === firstId.current);
    fromBottom.current = el && prepended ? el.scrollHeight - el.scrollTop : null;
    firstId.current = first;
  }

  // …and restore it once the new messages are laid out.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || fromBottom.current === null) return;
    el.scrollTop = el.scrollHeight - fromBottom.current;
    fromBottom.current = null;
  }, [first]);

  const chatId = store.sessionId;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    /** After a failed load, wait before trying again on scroll (the error toast is enough). */
    let pausedUntil = 0;
    const onScroll = () => {
      // Only the user's own scrolling (the transcript starts at the bottom).
      if (el.scrollTop > NEAR_TOP || store.start.value === 0 || store.loadingEarlier.value || store.status.value !== "ready") return;
      if (el.scrollHeight <= el.clientHeight || Date.now() < pausedUntil) return;
      const before = store.start.value;
      void loadEarlierMessages(chatId).then(() => {
        if (store.start.value === before) pausedUntil = Date.now() + RETRY_MS;
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef, chatId]);
}
