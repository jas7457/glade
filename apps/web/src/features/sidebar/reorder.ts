/**
 * Pure helpers for sidebar drag-and-drop reordering: flat lists (projects, pinned chats) and the
 * chat tree of a list (I-202: chats and folders mixed, chats into / out of / within folders).
 * Resolving the drop from the pointer position, applying a move and edge auto-scroll. The DOM
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

// The chat tree of a list (I-202) ----------------------------------------------------------------

/** One rendered row of a list's mixed order, in document order, with its box. */
export interface TreeRowRect extends VerticalRect {
  id: string;
  kind: "chat" | "folder";
  /** The folder a chat row is in (null at the top level; always null for folders). */
  parent: string | null;
  /** A folder row whose chats are shown below it. */
  open?: boolean;
}

/** Where a dragged chat or folder would land. */
export interface TreeDrop {
  /** The container it lands in: a folder id, or null for the list's top level. */
  parent: string | null;
  /** That container's rendered ids in the new order, the dragged one included. */
  order: string[];
  /** Where to draw the insertion line: on top of a row, or below the last one; `depth` 1 = inside a folder. */
  line: { id: string; edge: "top" | "bottom"; depth: 0 | 1 };
  /** Rows that slide down to open the gap (everything after the line). */
  shifted: string[];
}

const mid = (r: VerticalRect) => (r.top + r.bottom) / 2;
const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * Resolve a drop in a list's tree for a pointer at `y` (null: nothing would change, or no rows).
 *
 * A chat lands in the gap whose neighbours' midpoints surround the pointer; which container
 * that gap belongs to follows the row the pointer is over: the lower half of an open folder's
 * row or of a chat in a folder puts it in that folder, the upper half of a top-level row (or below
 * the last row) at the top level. So the gap under a folder's last chat is "end of the folder"
 * from above and "top level" from below. A folder only goes between top-level blocks (a folder
 * with its shown chats is one block): folders never nest.
 */
export function resolveTreeDrop(rows: readonly TreeRowRect[], draggedId: string, y: number): TreeDrop | null {
  const dragged = rows.find((r) => r.id === draggedId);
  if (!dragged) return null;
  return dragged.kind === "folder" ? folderDrop(rows, dragged, y) : chatDrop(rows, dragged, y);
}

function containerIds(rows: readonly TreeRowRect[], parent: string | null): string[] {
  return rows.filter((r) => r.parent === parent).map((r) => r.id);
}

function chatDrop(rows: readonly TreeRowRect[], dragged: TreeRowRect, y: number): TreeDrop | null {
  // Over its own (dimmed) row: it stays where it is.
  if (y >= dragged.top - 1 && y <= dragged.bottom + 1) return null;
  const rest = rows.filter((r) => r.id !== dragged.id);
  if (!rest.length) return null;
  let gap = 0;
  while (gap < rest.length && y > mid(rest[gap]!)) gap++;
  const prev = rest[gap - 1];
  const next = rest[gap];
  const overPrev = !!prev && (next ? y < (prev.bottom + next.top) / 2 : y <= prev.bottom);
  let parent: string | null = null;
  let insertAt: { after: string } | { before: string } | "start" | "end";
  if (!prev) insertAt = "start";
  else if (overPrev && prev.kind === "folder" && prev.open) {
    parent = prev.id;
    insertAt = "start";
  } else if (overPrev) {
    parent = prev.parent;
    insertAt = { after: prev.id };
  } else if (next) {
    parent = next.parent;
    insertAt = { before: next.id };
  } else insertAt = "end";
  const siblings = containerIds(rest, parent);
  const at =
    insertAt === "start" ? 0 : insertAt === "end" ? siblings.length : "after" in insertAt ? siblings.indexOf(insertAt.after) + 1 : siblings.indexOf(insertAt.before);
  const order = [...siblings.slice(0, at), dragged.id, ...siblings.slice(at)];
  if (parent === dragged.parent && sameOrder(order, containerIds(rows, parent))) return null;
  return {
    parent,
    order,
    line: next ? { id: next.id, edge: "top", depth: parent ? 1 : 0 } : { id: prev!.id, edge: "bottom", depth: parent ? 1 : 0 },
    shifted: rest.slice(gap).map((r) => r.id),
  };
}

function folderDrop(rows: readonly TreeRowRect[], dragged: TreeRowRect, y: number): TreeDrop | null {
  const rest = rows.filter((r) => r.id !== dragged.id && r.parent !== dragged.id);
  // Top-level blocks: a row and the chats shown under it.
  const blocks: Array<{ id: string; last: string; first: number; top: number; bottom: number }> = [];
  rest.forEach((r, i) => {
    if (r.parent === null) blocks.push({ id: r.id, last: r.id, first: i, top: r.top, bottom: r.bottom });
    else if (blocks.length) {
      const b = blocks[blocks.length - 1]!;
      b.last = r.id;
      b.bottom = r.bottom;
    }
  });
  if (!blocks.length) return null;
  let gap = 0;
  while (gap < blocks.length && y > mid(blocks[gap]!)) gap++;
  const order = blocks.map((b) => b.id);
  order.splice(gap, 0, dragged.id);
  if (sameOrder(order, containerIds(rows, null))) return null;
  const next = blocks[gap];
  return {
    parent: null,
    order,
    line: next ? { id: next.id, edge: "top", depth: 0 } : { id: blocks[gap - 1]!.last, edge: "bottom", depth: 0 },
    shifted: next ? rest.slice(next.first).map((r) => r.id) : [],
  };
}

/** How many of a list's entries to render: the limit, all when expanded, or up to the selection's. */
export function visibleEntryCount(entryHolds: ReadonlyArray<(id: string) => boolean>, limit: number, expanded: boolean, selectedId: string | null): number {
  if (expanded) return entryHolds.length;
  const selectedIdx = selectedId ? entryHolds.findIndex((holds) => holds(selectedId)) : -1;
  return Math.min(entryHolds.length, Math.max(limit, selectedIdx + 1));
}

/**
 * The vertical offset an element is moved by (the gap animation), from its computed `translate`
 * ("0px 6px", Tailwind 4's translate utilities) and `transform` (`matrix(...)`) values.
 */
export function shiftYOf(translate: string | undefined, transform: string | undefined): number {
  let y = 0;
  const parts = (translate ?? "").trim().split(/\s+/);
  if (parts.length >= 2) y += parseFloat(parts[1]!) || 0;
  const m = /^matrix\(([^)]+)\)$/.exec((transform ?? "").trim());
  if (m) y += Number(m[1]!.split(",")[5]) || 0;
  return y;
}
