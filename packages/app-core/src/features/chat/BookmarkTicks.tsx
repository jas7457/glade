/**
 * Tick marks on the transcript's scroll edge for its bookmarked messages (I-203): one small accent
 * mark per bookmark at the message's position in the conversation (for a reply: where its text
 * starts, like its ribbon, I-206); clicking it scrolls there and flashes it. Bookmarks whose message
 * isn't loaded (an earlier page) have no tick.
 *
 * Positions are measured from the rendered elements (jump-to-message's `findJumpTarget` /
 * `jumpElement`) after every render and whenever the content resizes (streaming, images).
 */
import type { RefObject } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import type { Bookmark, ChatMessage } from "@glade/protocol";
import type { RenderItem } from "./grouping";
import { findJumpTarget, jumpElement } from "./jump-to-message";

export interface BookmarkTicksProps {
  bookmarks: readonly Bookmark[];
  messages: readonly ChatMessage[];
  items: readonly RenderItem[];
  scrollRef: RefObject<HTMLElement>;
  contentRef: RefObject<HTMLElement>;
  /** Height floating over the bottom (the iPhone composer): the track ends above it. */
  bottomInset?: number;
  onJump: (el: HTMLElement) => void;
}

interface Tick {
  id: string;
  label: string;
  /** 0…1 along the track. */
  at: number;
}

/** Where `el` sits in the scrolled content, as a fraction of its full height (pure). */
export function tickPosition(elTop: number, scrollHeight: number): number {
  if (scrollHeight <= 0) return 0;
  return Math.max(0, Math.min(1, elTop / scrollHeight));
}

export function BookmarkTicks({ bookmarks, messages, items, scrollRef, contentRef, bottomInset = 0, onJump }: BookmarkTicksProps) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [version, setVersion] = useState(0);

  const elementOf = (b: Bookmark): HTMLElement | null => {
    const content = contentRef.current;
    const target = content ? findJumpTarget(messages, items, b.message) : null;
    return target && content ? jumpElement(content, target) : null;
  };

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const base = scroll.getBoundingClientRect().top - scroll.scrollTop;
    const next: Tick[] = [];
    for (const b of bookmarks) {
      const el = elementOf(b);
      if (!el) continue;
      next.push({ id: b.id, label: b.label, at: tickPosition(el.getBoundingClientRect().top - base, scroll.scrollHeight) });
    }
    setTicks((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [bookmarks, messages, items, version]);

  // Content height changes (streaming, images loading, Show more): measure again, once a frame.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setVersion((v) => v + 1));
    });
    ro.observe(content);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);

  if (!ticks.length) return null;
  return (
    <div
      class="pointer-events-none absolute top-1.5 right-0 w-3"
      style={{ bottom: `${6 + bottomInset}px` }}
      role="group"
      aria-label="Bookmarks in this chat"
      data-testid="bookmark-ticks"
    >
      {ticks.map((t) => (
        <button
          key={t.id}
          type="button"
          title={t.label}
          aria-label={`Jump to bookmark: ${t.label}`}
          onClick={() => {
            const b = bookmarks.find((x) => x.id === t.id);
            const el = b ? elementOf(b) : null;
            if (el) onJump(el);
          }}
          style={{ top: `${t.at * 100}%` }}
          class="group/tick pointer-events-auto absolute right-0 flex h-2.5 w-3 -translate-y-1/2 items-center justify-end pr-[3px] outline-none"
        >
          <span class="h-[3px] w-2 rounded-full bg-accent opacity-60 group-hover/tick:opacity-100 group-focus-visible/tick:opacity-100 group-focus-visible/tick:ring-2 group-focus-visible/tick:ring-accent/50" />
        </button>
      ))}
    </div>
  );
}
