/**
 * Horizontal split with a draggable divider (like NSSplitView). `end` is optional: without it
 * `start` takes the full width and no divider is shown.
 *
 *   <SplitView start={<Main />} end={<Side />} size={0.5}
 *     onResize={(f) => …} onResizeEnd={(f) => save(f)} />
 *
 * `size` is the width of the `end` pane as a fraction (0..1) of the whole. The divider is a
 * hairline with a wider invisible hit area; drag it, use ←/→ when focused, or double-click to
 * reset to `defaultSize`. `onResize` fires while dragging, `onResizeEnd` once at the end.
 */
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import { cn } from "@glade/app-core/lib/cn";

export interface SplitViewProps {
  start: ComponentChildren;
  end?: ComponentChildren | null;
  /** Width of the end pane as a fraction of the whole. */
  size: number;
  /** Double-click on the divider resets to this (default 0.5). */
  defaultSize?: number;
  /** Fraction limits for `size` (default 0.2..0.8). */
  min?: number;
  max?: number;
  /** Minimum width of either pane in px (default 280). */
  minPanePx?: number;
  onResize?: (size: number) => void;
  onResizeEnd?: (size: number) => void;
  /** Accessible name of the divider. */
  label?: string;
  class?: string;
}

export function SplitView({
  start,
  end,
  size,
  defaultSize = 0.5,
  min = 0.2,
  max = 0.8,
  minPanePx = 280,
  onResize,
  onResizeEnd,
  label = "Resize panes",
  class: className,
}: SplitViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(size);
  const hasEnd = end !== undefined && end !== null && end !== false;

  const clamp = (fraction: number) => {
    const width = rootRef.current?.clientWidth ?? 0;
    let lo = min;
    let hi = max;
    if (width > 0) {
      lo = Math.max(lo, minPanePx / width);
      hi = Math.min(hi, 1 - minPanePx / width);
    }
    return lo > hi ? 0.5 : Math.min(hi, Math.max(lo, fraction));
  };

  const set = (fraction: number) => {
    latest.current = clamp(fraction);
    onResize?.(latest.current);
  };

  const fromPointer = (clientX: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    set((rect.right - clientX) / rect.width);
  };

  return (
    <div ref={rootRef} class={cn("flex h-full min-h-0 min-w-0", className)}>
      <div class="flex min-w-0 flex-1 flex-col">{start}</div>
      {hasEnd && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-valuemin={Math.round(min * 100)}
            aria-valuemax={Math.round(max * 100)}
            aria-valuenow={Math.round((1 - size) * 100)}
            tabIndex={0}
            class="relative z-10 w-px shrink-0 bg-separator outline-none focus-visible:bg-accent"
            onKeyDown={(e) => {
              const step = e.shiftKey ? 0.1 : 0.02;
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              set(size + (e.key === "ArrowLeft" ? step : -step));
              onResizeEnd?.(latest.current);
            }}
          >
            <div
              class="absolute inset-y-0 -left-[3px] w-[7px] cursor-col-resize"
              onPointerDown={(e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                latest.current = size;
                setDragging(true);
              }}
              onPointerMove={(e) => dragging && fromPointer(e.clientX)}
              onPointerUp={() => {
                if (!dragging) return;
                setDragging(false);
                onResizeEnd?.(latest.current);
              }}
              onDblClick={() => {
                set(defaultSize);
                onResizeEnd?.(latest.current);
              }}
            />
            {dragging && <div class="fixed inset-0 cursor-col-resize" />}
          </div>
          <div class="flex min-w-0 shrink-0 flex-col" style={{ width: `${size * 100}%` }}>
            {end}
          </div>
        </>
      )}
    </div>
  );
}
