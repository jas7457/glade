/**
 * Drag ghost (I-202): a translucent copy of the row being dragged that follows the pointer, like
 * a Finder drag. The copy trails just below the pointer, sits above everything (no pointer events), and
 * has a "not allowed" look while the pointer is somewhere the item can't go (the caller also sets
 * the cursor). Hooks and ids are stripped from the copy so DOM lookups never find it.
 *
 * Imperative (created on drag start, removed on drop) because it lives outside the component tree.
 */

/** Attributes the copy must not carry (sortable and drop-target lookups, test ids, ids). */
const STRIP = ["id", "data-sort-group", "data-sort-id", "data-drop-into", "data-drop-accept", "data-drop-area", "data-chat-id", "data-folder-id", "data-project-id", "data-tree-kind"];

/** How far below the pointer the ghost's top sits, and how far right of the grab point (px). */
const GHOST_BELOW_POINTER = 16;
const GHOST_NUDGE_X = 8;

export const dragGhostClass = {
  base: "pointer-events-none fixed z-50 overflow-hidden rounded-[6px] bg-sidebar text-sidebar-fg shadow-floating ring-1 ring-separator",
  allowed: "opacity-80",
  notAllowed: "opacity-40",
} as const;

export interface DragGhost {
  /** Follow the pointer. */
  move(x: number, y: number): void;
  /** Dim it where the item can't be dropped. */
  setAllowed(allowed: boolean): void;
  remove(): void;
}

export function createDragGhost(source: HTMLElement, x: number, y: number): DragGhost {
  const rect = source.getBoundingClientRect();
  // It keeps the horizontal grab offset but trails just below the pointer, so the insertion line
  // (always within half a row of the pointer) stays visible above it.
  const offsetX = x - rect.left - GHOST_NUDGE_X;
  const offsetY = -GHOST_BELOW_POINTER;
  const copy = source.cloneNode(true) as HTMLElement;
  for (const el of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    for (const name of STRIP) el.removeAttribute(name);
    el.removeAttribute("aria-selected");
  }
  // Drop lines and dividers of the source aren't part of the row.
  for (const el of copy.querySelectorAll("[data-drop-line], [data-pinned-divider]")) el.remove();
  const ghost = document.createElement("div");
  ghost.setAttribute("aria-hidden", "true");
  ghost.dataset.dragGhost = "";
  ghost.className = `${dragGhostClass.base} ${dragGhostClass.allowed}`;
  ghost.style.width = `${rect.width}px`;
  ghost.appendChild(copy);
  const place = (px: number, py: number) => {
    ghost.style.left = `${px - offsetX}px`;
    ghost.style.top = `${py - offsetY}px`;
  };
  place(x, y);
  document.body.appendChild(ghost);
  return {
    move: place,
    setAllowed(allowed) {
      ghost.className = `${dragGhostClass.base} ${allowed ? dragGhostClass.allowed : dragGhostClass.notAllowed}`;
      if (allowed) delete ghost.dataset.notAllowed;
      else ghost.dataset.notAllowed = "";
    },
    remove() {
      ghost.remove();
    },
  };
}
