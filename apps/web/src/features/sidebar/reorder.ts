/**
 * Pure helpers for sidebar drag-and-drop reordering (projects, pinned chats): resolving the drop
 * gap from the pointer position, applying a move, keyboard moves and edge auto-scroll. The DOM
 * side lives in `useSortable.ts`.
 *
 * A "gap" is an insertion position between items: 0 = before the first item, n = after the last.
 */

export interface VerticalRect {
  top: number;
  bottom: number;
}

/** Insertion gap for a pointer at `y`: the number of items whose vertical midpoint is above it. */
export function resolveDropGap(rects: readonly VerticalRect[], y: number): number {
  let gap = 0;
  for (const r of rects) {
    if (y > (r.top + r.bottom) / 2) gap++;
    else break;
  }
  return gap;
}

/** Dropping item `from` into `gap` leaves the order unchanged (just above or below itself). */
export function isNoopDrop(from: number, gap: number): boolean {
  return gap === from || gap === from + 1;
}

/** Move the item at `from` into `gap`. Returns null when nothing changes or indices are invalid. */
export function moveToGap<T>(items: readonly T[], from: number, gap: number): T[] | null {
  if (from < 0 || from >= items.length || gap < 0 || gap > items.length || isNoopDrop(from, gap)) return null;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(gap > from ? gap - 1 : gap, 0, item as T);
  return next;
}

/**
 * Scroll speed (px per frame) when dragging near the top/bottom edge of a scroll container:
 * negative scrolls up, 0 outside the edge zones. Grows linearly towards the edge.
 */
export function autoScrollDelta(y: number, container: VerticalRect, edge = 40, maxSpeed = 14): number {
  const height = container.bottom - container.top;
  const zone = Math.min(edge, height / 3);
  if (zone <= 0) return 0;
  if (y < container.top + zone) return -Math.ceil(maxSpeed * Math.min(1, (container.top + zone - y) / zone));
  if (y > container.bottom - zone) return Math.ceil(maxSpeed * Math.min(1, (y - (container.bottom - zone)) / zone));
  return 0;
}

/** Whether the pointer moved far enough from where it went down to start a drag. */
export function passedThreshold(dx: number, dy: number, threshold = 4): boolean {
  return dx * dx + dy * dy >= threshold * threshold;
}

/**
 * Where to draw the insertion line for `gap` relative to item `index` of `count` items: on top
 * of the item right after the gap, or at the bottom of the last item for the end gap.
 */
export function dropLineEdge(index: number, gap: number | null, count: number): "top" | "bottom" | null {
  if (gap === null) return null;
  if (gap === index) return "top";
  if (gap === count && index === count - 1) return "bottom";
  return null;
}

/**
 * Apply a reorder of the rendered (possibly truncated) list to the full list: items that aren't
 * rendered (e.g. hidden behind "Show more", always at the end) keep their order after them.
 */
export function mergeVisibleOrder(all: readonly string[], visible: readonly string[]): string[] {
  const shown = new Set(visible);
  return [...visible.filter((id) => all.includes(id)), ...all.filter((id) => !shown.has(id))];
}
