/**
 * Small pointer-based sortable for short sidebar lists (projects, pinned chats). We don't use a
 * drag-and-drop library: the sidebar shows an insertion line (Finder style) rather than
 * shifting rows, and the lists are a handful of items.
 *
 * - `bind(id, index, count)` gives each item: `item` props for the element that is measured and
 *   dimmed (e.g. a whole project group), `handle` props for the element that starts a drag (e.g.
 *   the project row; can be the same element), and where to draw the drop line.
 * - A drag starts only after the pointer moves a few pixels, so clicks, context menus, rename and
 *   hover buttons keep working; the click that ends a drag is swallowed.
 * - Esc cancels; the nearest scroll container auto-scrolls near its edges.
 *
 * Index math lives in `reorder.ts` (unit tested).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { autoScrollDelta, dropLineEdge, isNoopDrop, mergeVisibleOrder, moveToGap, passedThreshold, resolveDropGap } from "./reorder";

export interface SortableOptions {
  /** Unique name of this list (items are found in the DOM by it). */
  group: string;
  /** Current order of all items (including any not rendered). */
  ids: readonly string[];
  /** Called with the full new order after a drop that changes it. */
  onReorder: (ids: string[]) => void;
  disabled?: boolean;
}

export interface SortableState {
  /** Item being dragged (after the movement threshold). */
  draggingId: string | null;
  /** Insertion gap among the rendered items, or null when the drop wouldn't change anything. */
  gap: number | null;
}

/** Everything one rendered item needs (see `bind`). */
export interface SortBinding {
  /** Spread on the measured element (make it `relative` for the drop line). */
  item: { "data-sort-group": string; "data-sort-id": string };
  /** Spread on the element that starts a drag. */
  handle: { onPointerDown: (e: PointerEvent) => void };
  dragging: boolean;
  /** Where to draw the insertion line on this item. */
  dropEdge: "top" | "bottom" | null;
}

interface Session {
  id: string;
  startX: number;
  startY: number;
  lastY: number;
  started: boolean;
  cancelled: boolean;
  scroller: HTMLElement | null;
  frame: number;
}

const IGNORE_TARGETS = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [aria-haspopup], [data-no-drag]";

function scrollParent(el: Element | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/** Swallow the click the browser fires after a drag ends on a button. */
function suppressNextClick(): void {
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

export function useSortable(options: SortableOptions) {
  const [state, setState] = useState<SortableState>({ draggingId: null, gap: null });
  const opts = useRef(options);
  opts.current = options;
  const session = useRef<Session | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const elements = () =>
    [...document.querySelectorAll<HTMLElement>("[data-sort-group]")].filter((el) => el.dataset.sortGroup === opts.current.group && el.dataset.sortId);

  /** Rendered ids and the drop gap for the pointer's current position. */
  const measure = (s: Session) => {
    const els = elements();
    const visible = els.map((el) => el.dataset.sortId as string);
    const gap = resolveDropGap(
      els.map((el) => el.getBoundingClientRect()),
      s.lastY,
    );
    const from = visible.indexOf(s.id);
    return { visible, from, gap };
  };

  const update = (s: Session) => {
    const { from, gap } = measure(s);
    const shown = from === -1 || isNoopDrop(from, gap) ? null : gap;
    setState((prev) => (prev.draggingId === s.id && prev.gap === shown ? prev : { draggingId: s.id, gap: shown }));
  };

  const finish = (commit: boolean) => {
    const s = session.current;
    cleanup.current?.();
    if (!s?.started) return;
    suppressNextClick();
    setState({ draggingId: null, gap: null });
    if (!commit || s.cancelled) return;
    const { visible, from, gap } = measure(s);
    const moved = moveToGap(visible, from, gap);
    if (moved) opts.current.onReorder(mergeVisibleOrder(opts.current.ids, moved));
  };

  const onPointerDown = (id: string) => (e: PointerEvent) => {
    if (opts.current.disabled || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if ((e.target as Element | null)?.closest?.(IGNORE_TARGETS)) return;
    cleanup.current?.();
    const s: Session = { id, startX: e.clientX, startY: e.clientY, lastY: e.clientY, started: false, cancelled: false, scroller: null, frame: 0 };
    session.current = s;
    const origin = e.currentTarget as Element;

    const tick = () => {
      if (!s.started || s.cancelled || !s.scroller) return;
      const delta = autoScrollDelta(s.lastY, s.scroller.getBoundingClientRect());
      if (delta !== 0) {
        s.scroller.scrollTop += delta;
        update(s);
      }
      s.frame = requestAnimationFrame(tick);
    };

    const onMove = (ev: PointerEvent) => {
      if (s.cancelled) return;
      s.lastY = ev.clientY;
      if (!s.started) {
        if (!passedThreshold(ev.clientX - s.startX, ev.clientY - s.startY)) return;
        s.started = true;
        s.scroller = scrollParent(origin);
        // No hover highlights / hover buttons on the rows being dragged over.
        if (s.scroller) s.scroller.style.pointerEvents = "none";
        s.frame = requestAnimationFrame(tick);
      }
      ev.preventDefault();
      update(s);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" || !s.started || s.cancelled) return;
      ev.preventDefault();
      ev.stopPropagation();
      s.cancelled = true;
      cancelAnimationFrame(s.frame);
      setState({ draggingId: null, gap: null });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
    cleanup.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      cancelAnimationFrame(s.frame);
      if (s.scroller) s.scroller.style.pointerEvents = "";
      if (session.current === s) session.current = null;
      cleanup.current = null;
    };
  };

  /** Props for the item `id` rendered at `index` of `count` rendered items. */
  const bind = (id: string, index: number, count: number): SortBinding => ({
    item: { "data-sort-group": options.group, "data-sort-id": id },
    handle: { onPointerDown: onPointerDown(id) },
    dragging: state.draggingId === id,
    dropEdge: dropLineEdge(index, state.gap, count),
  });

  return { ...state, bind };
}
