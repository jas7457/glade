/**
 * Pointer-based drag and drop for the sidebar. We don't use a drag-and-drop library: the lists
 * are short, and the feedback is Finder-like (I-202):
 *
 * - the dragged row follows the pointer as a translucent ghost copy (`ui/drag-ghost`) while its
 *   own slot is dimmed;
 * - an accent insertion line (with a dot at its start) shows where it lands, indented to the
 *   depth it will land at; rows after it slide down a little to open the gap
 *   (`sidebarClass.dropShift`, no animation with reduced motion);
 * - a folder row it would go into is highlighted (`dropIntoTarget`); a closed one opens after a
 *   short hover (`onHoverTarget`, ~600 ms);
 * - outside its area (`data-drop-area`, e.g. the item's own project) nothing is shown and the
 *   ghost and cursor turn "not allowed"; a drop there does nothing.
 *
 * Two hooks share one drag session (`useDrag`): `useSortable` for flat lists (projects, pinned
 * chats) and `useChatTree` for a list's mixed chats and folders (I-202). A drag starts only after
 * the pointer moves a few pixels, so clicks, context menus, rename and hover buttons keep working;
 * the click that ends a drag is swallowed. Esc cancels; the nearest scroll container auto-scrolls
 * near its edges.
 *
 * Drop targets (folders, I-165): an element with `data-drop-into="<target id>"` and
 * `data-drop-accept="<kinds>"` takes items whose `into.kind` is listed; while the pointer is over
 * it (its middle half with `into.band`, so the gaps around it still work) it's highlighted and a
 * drop calls `into.onDrop` instead of reordering.
 *
 * Index math lives in `reorder.ts` (unit tested).
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { signal } from "@preact/signals";
import { createDragGhost, type DragGhost } from "@glade/app-core/ui";
import {
  autoScrollDelta,
  dropLineEdge,
  isNoopDrop,
  mergeVisibleOrder,
  moveToGap,
  passedThreshold,
  resolveDropGap,
  resolveTreeDrop,
  shiftYOf,
  type TreeDrop,
  type TreeRowRect,
  type VerticalRect,
} from "./reorder";

/** How long the pointer rests on a closed folder before it opens (I-202). */
export const EXPAND_DELAY_MS = 600;

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

/** Props of the element a drag must stay inside (its area); elsewhere is "not allowed". */
export function dropAreaProps(area: string): { "data-drop-area": string } {
  return { "data-drop-area": area };
}

/** The target at the pointer accepting `into.kind` (and allowed for `id`), or null. */
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

/** Whether the pointer is inside the drag's area (no area, or no layout as in tests: anywhere). */
function inArea(area: string | undefined, x: number, y: number): boolean {
  if (!area) return true;
  const el = [...document.querySelectorAll<HTMLElement>("[data-drop-area]")].find((e) => e.dataset.dropArea === area);
  if (!el) return true;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return true;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** An element's box without the gap animation's offset (so rows don't flicker while sliding). */
function layoutRect(el: HTMLElement): VerticalRect {
  const r = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const dy = shiftYOf(style.translate, style.transform);
  return { top: r.top - dy, bottom: r.bottom - dy };
}

function groupElements(group: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-sort-group]")].filter((el) => el.dataset.sortGroup === group && el.dataset.sortId);
}

interface DragOptions<P> {
  group: string;
  disabled?: boolean;
  area?: string;
  into?: DropInto;
  onHoverTarget?: (target: string) => void;
  /** The drop for the pointer at `y` (null: nothing would change here). */
  resolve: (id: string, y: number) => P | null;
  commit: (id: string, plan: P) => void;
}

interface DragState<P> {
  /** Item being dragged (after the movement threshold). */
  draggingId: string | null;
  /** The reorder a drop here makes, or null. */
  plan: P | null;
  /** Drop target under the pointer (`into`), which wins over the plan. */
  target: string | null;
  /** False while the pointer is outside the area. */
  allowed: boolean;
}

interface Session<P> {
  id: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  started: boolean;
  cancelled: boolean;
  scroller: HTMLElement | null;
  frame: number;
  ghost: DragGhost | null;
  plan: P | null;
  target: string | null;
  hoverTimer: ReturnType<typeof setTimeout> | null;
}

const IGNORE_TARGETS = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [aria-haspopup], [data-no-drag]";
const IDLE = { draggingId: null, plan: null, target: null, allowed: true };

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

function setCursor(cursor: string): void {
  document.documentElement.style.cursor = cursor;
}

/** The drag session shared by both hooks. */
function useDrag<P>(options: DragOptions<P>) {
  const [state, setState] = useState<DragState<P>>(IDLE);
  const opts = useRef(options);
  opts.current = options;
  const session = useRef<Session<P> | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanup.current?.(), []);

  const update = (s: Session<P>) => {
    const o = opts.current;
    const allowed = inArea(o.area, s.lastX, s.lastY);
    const target = allowed && o.into ? findTarget(o.into, s.id, s.lastX, s.lastY) : null;
    const plan = allowed && target === null ? o.resolve(s.id, s.lastY) : null;
    s.plan = plan;
    s.ghost?.move(s.lastX, s.lastY);
    s.ghost?.setAllowed(allowed);
    setCursor(allowed ? "" : "not-allowed");
    if (target !== s.target) {
      if (s.hoverTimer) clearTimeout(s.hoverTimer);
      s.hoverTimer = target !== null && o.onHoverTarget ? setTimeout(() => opts.current.onHoverTarget?.(target), EXPAND_DELAY_MS) : null;
      s.target = target;
    }
    if (dropIntoTarget.value !== target) dropIntoTarget.value = target;
    setState((prev) =>
      prev.draggingId === s.id && prev.target === target && prev.allowed === allowed && JSON.stringify(prev.plan) === JSON.stringify(plan)
        ? prev
        : { draggingId: s.id, plan, target, allowed },
    );
  };

  const reset = (s: Session<P>) => {
    if (s.hoverTimer) clearTimeout(s.hoverTimer);
    s.hoverTimer = null;
    s.ghost?.remove();
    s.ghost = null;
    setCursor("");
    dropIntoTarget.value = null;
    setState(IDLE);
  };

  const finish = (commit: boolean) => {
    const s = session.current;
    cleanup.current?.();
    if (!s?.started) return;
    suppressNextClick();
    if (!s.cancelled) {
      // Where the pointer is now (it may have moved since the last frame).
      update(s);
      reset(s);
    }
    if (!commit || s.cancelled) return;
    if (s.target !== null) opts.current.into!.onDrop(s.id, s.target);
    else if (s.plan !== null) opts.current.commit(s.id, s.plan);
  };

  const onPointerDown = (id: string) => (e: PointerEvent) => {
    if (opts.current.disabled || e.button !== 0 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if ((e.target as Element | null)?.closest?.(IGNORE_TARGETS)) return;
    cleanup.current?.();
    const s: Session<P> = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      started: false,
      cancelled: false,
      scroller: null,
      frame: 0,
      ghost: null,
      plan: null,
      target: null,
      hoverTimer: null,
    };
    session.current = s;
    const origin = e.currentTarget as HTMLElement;

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
        s.ghost = createDragGhost(origin, s.startX, s.startY);
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
      reset(s);
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
      if (s.hoverTimer) clearTimeout(s.hoverTimer);
      if (s.scroller) s.scroller.style.pointerEvents = "";
      if (s.ghost) {
        s.ghost.remove();
        s.ghost = null;
        setCursor("");
      }
      if (session.current === s) session.current = null;
      cleanup.current = null;
    };
  };

  return { state, onPointerDown };
}

// Flat lists (projects, pinned chats) ---------------------------------------------------------------

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
  /** The element the drag must stay in (`dropAreaProps`). */
  area?: string;
  /** Called after resting on a drop target (opens a closed folder). */
  onHoverTarget?: (target: string) => void;
}

interface FlatPlan {
  gap: number;
  from: number;
  visible: string[];
}

/** Everything one rendered item needs (see `bind`). */
export interface SortBinding {
  /** Spread on the measured element (make it `relative` for the drop line). */
  item: { "data-sort-group": string; "data-sort-id": string };
  /** Spread on the element that starts a drag (its copy is the ghost). */
  handle: { onPointerDown: (e: PointerEvent) => void };
  dragging: boolean;
  /** Where to draw the insertion line on this item. */
  dropEdge: "top" | "bottom" | null;
  /** Slides down to open the gap (`sidebarClass.dropShift`). */
  shifted: boolean;
}

export function useSortable(options: SortableOptions) {
  const { state, onPointerDown } = useDrag<FlatPlan>({
    group: options.group,
    disabled: options.disabled,
    area: options.area,
    into: options.into,
    onHoverTarget: options.onHoverTarget,
    resolve: (id, y) => {
      if (options.reorder === false) return null;
      const els = groupElements(options.group);
      const visible = els.map((el) => el.dataset.sortId as string);
      const gap = resolveDropGap(els.map(layoutRect), y);
      const from = visible.indexOf(id);
      return from === -1 || isNoopDrop(from, gap) ? null : { gap, from, visible };
    },
    commit: (id, plan) => {
      const moved = moveToGap(plan.visible, plan.from, plan.gap);
      if (moved) options.onReorder(mergeVisibleOrder(options.ids, moved), id);
    },
  });

  /** Props for the item `id` rendered at `index` of `count` rendered items. */
  const bind = (id: string, index: number, count: number): SortBinding => ({
    item: { "data-sort-group": options.group, "data-sort-id": id },
    handle: { onPointerDown: onPointerDown(id) },
    dragging: state.draggingId === id,
    dropEdge: dropLineEdge(index, state.plan?.gap ?? null, count),
    shifted: state.plan !== null && index >= state.plan.gap && state.draggingId !== id,
  });

  return { draggingId: state.draggingId, gap: state.plan?.gap ?? null, target: state.target, allowed: state.allowed, bind };
}

// A list's chat tree (I-202) --------------------------------------------------------------------------

export interface ChatTreeOptions {
  group: string;
  area?: string;
  /** Folder rows as drop targets (dropping *into* a folder). */
  into?: DropInto;
  onHoverTarget?: (target: string) => void;
  /** A drop that changes the order: `drop.parent`'s rendered ids in their new order. */
  onDrop: (id: string, drop: TreeDrop) => void;
  disabled?: boolean;
}

/** What one tree row needs (see `bind`). */
export interface TreeBinding {
  item: { "data-sort-group": string; "data-sort-id": string; "data-tree-kind": "chat" | "folder"; "data-tree-parent"?: string; "data-tree-open"?: "" };
  handle: { onPointerDown: (e: PointerEvent) => void };
  dragging: boolean;
  /** The insertion line on this row, with the depth it lands at (0 top level, 1 in a folder). */
  drop: { edge: "top" | "bottom"; depth: 0 | 1 } | null;
  shifted: boolean;
}

function treeRows(group: string): TreeRowRect[] {
  return groupElements(group).map((el) => ({
    id: el.dataset.sortId as string,
    kind: el.dataset.treeKind === "folder" ? "folder" : "chat",
    parent: el.dataset.treeParent ?? null,
    open: el.dataset.treeOpen !== undefined,
    ...layoutRect(el),
  }));
}

export function useChatTree(options: ChatTreeOptions) {
  const { state, onPointerDown } = useDrag<TreeDrop>({
    group: options.group,
    disabled: options.disabled,
    area: options.area,
    into: options.into,
    onHoverTarget: options.onHoverTarget,
    resolve: (id, y) => resolveTreeDrop(treeRows(options.group), id, y),
    commit: (id, drop) => options.onDrop(id, drop),
  });
  const shifted = new Set(state.plan?.shifted ?? []);

  /** Props for a row: a chat (in folder `parent`, or at the top level) or a folder (`open`: its chats show). */
  const bind = (id: string, kind: "chat" | "folder", parent: string | null = null, open = false): TreeBinding => ({
    item: {
      "data-sort-group": options.group,
      "data-sort-id": id,
      "data-tree-kind": kind,
      ...(parent ? { "data-tree-parent": parent } : {}),
      ...(open ? { "data-tree-open": "" as const } : {}),
    },
    handle: { onPointerDown: onPointerDown(id) },
    dragging: state.draggingId === id,
    drop: state.plan?.line.id === id ? { edge: state.plan.line.edge, depth: state.plan.line.depth } : null,
    shifted: shifted.has(id),
  });

  return { draggingId: state.draggingId, target: state.target, allowed: state.allowed, gapOpen: shifted.size > 0, bind };
}
