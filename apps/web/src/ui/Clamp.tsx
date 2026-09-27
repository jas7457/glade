/**
 * Content clamped to a number of lines, with a fade at the bottom edge and a "Show more" /
 * "Show less" toggle (I-109). The toggle only appears when the content really overflows
 * (measured, re-measured on resize), so short content renders as-is.
 *
 *   <Clamp lines={15}>{text}</Clamp>
 *   <Clamp lines={3} moreLabel="Show full task"><Markdown text={task} /></Clamp>
 */
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { cn } from "@/lib/cn";

export interface ClampProps {
  /** Visible lines while collapsed. */
  lines: number;
  /** Line height of the content in em (default 1.5), to turn `lines` into a height. */
  lineHeight?: number;
  moreLabel?: string;
  lessLabel?: string;
  children: ComponentChildren;
  /** Classes for the wrapper. */
  class?: string;
  /** Classes for the clamped content box. */
  contentClass?: string;
  /** Classes for the toggle button. */
  toggleClass?: string;
}

const FADE = "linear-gradient(to bottom, #000 calc(100% - 2.2em), transparent)";

export function Clamp({ lines, lineHeight = 1.5, moreLabel = "Show more", lessLabel = "Show less", children, class: className, contentClass, toggleClass }: ClampProps) {
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Measure while collapsed (open content has no limit to compare against).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  });

  const clamped = !open;
  const fade = clamped && overflowing;
  return (
    <div class={className} data-clamp={open ? "open" : overflowing ? "clamped" : "fits"}>
      <div
        ref={ref}
        class={cn(clamped && "overflow-hidden", contentClass)}
        style={{
          maxHeight: clamped ? `${lines * lineHeight}em` : undefined,
          maskImage: fade ? FADE : undefined,
          WebkitMaskImage: fade ? FADE : undefined,
        }}
      >
        {children}
      </div>
      {(overflowing || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          class={cn("mt-1 text-[0.88rem] font-medium text-fg-muted outline-none hover:text-fg focus-visible:underline", toggleClass)}
        >
          {open ? lessLabel : moreLabel}
        </button>
      )}
    </div>
  );
}
