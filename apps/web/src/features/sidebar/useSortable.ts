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
 * - Folders (I-165): `into` makes rows elsewhere drop targets. An element with
 *   `data-drop-into="<target id>"` ("" = out of any folder) and `data-drop-accept="<kinds>"`
 *   takes items whose `into.kind` is listed; while the pointer is over it (its middle half with
 *   `into.band`, so the gaps around it still work) it's highlighted (`dropIntoTarget`) and a drop
 *   calls `into.onDrop` instead of reordering. `reorder: false` makes items draggable only into
 *   targets (e.g. unpinned chats).
 *
 * Index math lives in `reorder.ts` (unit tested).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { autoScrollDelta, dropLineEdge, isNoopDrop, mergeVisibleOrder, moveToGap, passedThreshold, resolveDropGap } from "./reorder";

export interface SortableOptions {
  /** Unique name of this list (items are found in the DOM by it). */
  group: string;
  /** Current order of all items (including any not rendered). */
  ids: readonly string[];
  /** Called with the full new order after a drop that changes it (and the item that moved). */
  onReorder: (ids: string[], movedId: string) => void;
  disabled?: boolean;
  /** Reorder by dropping into gaps (default true). */
  reorder?: boolean;
  /** Drop targets outside the list (folders, I-165). */
  into?: DropInto;
}

export interface DropInto {
  /** What the items are, matched against targets' `data-drop-accept` (space separated). */
  kind: string;
  /** Only the target's middle half counts (the target is also a row of this list). */
  band?: boolean;
  /** Whether `id` may go into `target` (e.g. not the folder it's already in). */
  canDrop?: (id: string, target: string) => boolean;
  onDrop: (id: string, target: string) => void;
}

/** The drop target under the pointer while dragging (`data-drop-into` value), for highlighting. */
export const dropIntoTarget = signal<string | null>(null);

/** Props that make an element a drop target for items of `accept` kinds. */
export function dropTargetProps(target: string, accept: string): { "data-drop-into": string; "data-drop-accept": string } {
  return { "data-drop-into": target, "data-drop-accept": accept };
}

/** The target at `y` accepting `into.kind` (and allowed for `id`), or null. */
function findTarget(into: DropInto, id: string, x: number, y: number): string | null {
  for (const el of document.querySelectorAll<HTMLElement>("[data-drop-into]")) {
    if (!(el.dataset.dropAccept ?? "").split(" ").includes(into.kind)) continue;
    const r = el.getBoundingClientRect();
    const top = into.band ? r.top + r.height / 4 : r.top;
    const bottom = into.band ? r.bottom - r.height / 4 : r.bottom;
    if (y < top || y > bottom || x < r.left || x > r.right) continue;
    const target = el.dataset.dropInto ?? "";
    if (into.canDrop && !into.canDrop(id, target)) continue;
    return target;
  }
  return null;
}

export interface SortableState {
  /** Item being dragged (after the movement threshold). */
  draggingId: string | null;
  /** Insertion gap among the rendered items, or null when the drop wouldn't change anything. */
  gap: number | null;
  /** Drop target under the pointer (`into`), which wins over the gap. */
  target: string | null;
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
  lastX: number;
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
  const [state, setState] = useState<SortableState>({ draggingId: null, gap: null, target: null });
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

  const targetOf = (s: Session) => (opts.current.into ? findTarget(opts.current.into, s.id, s.lastX, s.lastY) : null);

  const update = (s: Session) => {
    const target = targetOf(s);
    let shown: number | null = null;
    if (target === null && opts.current.reorder !== false) {
      const { from, gap } = measure(s);
      shown = from === -1 || isNoopDrop(from, gap) ? null : gap;
    }
    if (dropIntoTarget.value !== target) dropIntoTarget.value = target;
    setState((prev) => (prev.draggingId === s.id && prev.gap === shown && prev.target === target ? prev : { draggingId: s.id, gap: shown, target }));
  };

  const finish = (commit: boolean) => {
    const s = session.current;
    cleanup.current?.();
    if (!s?.started) return;
    suppressNextClick();
    setState({ draggingId: null, gap: null, target: null });
    dropIntoTarget.value = null;
    if (!commit || s.cancelled) return;
    const target = targetOf(s);
    if (target !== null) {
      opts.current.into!.onDrop(s.id, target);
      return;
    }
    if (opts.current.reorder === false) return;
    const { visible, from, gap } = measure(s);
    const moved = moveToGap(visible, from, gap);
    if (moved) opts.current.onReorder(mergeVisibleOrder(opts.current.ids, moved), s.id);
  };

  const onPointerDown = (id: string) => (e: PointerEvent) => {
    if (opts.current.disabled || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if ((e.target as Element | null)?.closest?.(IGNORE_TARGETS)) return;
    cleanup.current?.();
    const s: Session = { id, startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY, started: false, cancelled: false, scroller: null, frame: 0 };
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
      s.lastX = ev.clientX;
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
      dropIntoTarget.value = null;
      setState({ draggingId: null, gap: null, target: null });
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
