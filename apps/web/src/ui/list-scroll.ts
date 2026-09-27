/**
 * Keep the highlighted row of a keyboard-navigated list visible by scrolling **only the list
 * container** (I-047). `Element.scrollIntoView` also scrolls every scrollable ancestor (the
 * transcript, the page), which made the slash menu jump.
 *
 * Row above the viewport → align its top (or its group header's, when it's the first row of a
 * group, so the header stays visible); row below → align its bottom. Scroll padding (the
 * container's `padding-top/bottom`) is respected so rows don't stick to the edge.
 */

/** Offset of `el`'s top edge inside `container`'s scrollable content. */
function offsetWithin(container: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
}

function px(value: string | undefined): number {
  const n = Number.parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

export interface ScrollRowOptions {
  /**
   * Element that should become visible together with the row when scrolling up (typically the
   * group header above the first row of a group).
   */
  header?: HTMLElement | null;
}

/** Scroll `container` (only) so `row` is fully visible. No-op when it already is. */
export function scrollRowIntoView(container: HTMLElement | null | undefined, row: HTMLElement | null | undefined, options: ScrollRowOptions = {}): void {
  if (!container || !row || !container.contains(row)) return;
  const style = typeof getComputedStyle === "function" ? getComputedStyle(container) : undefined;
  const padTop = px(style?.paddingTop);
  const padBottom = px(style?.paddingBottom);
  const view = container.clientHeight;
  const top = offsetWithin(container, row);
  const bottom = top + row.offsetHeight;
  const header = options.header && container.contains(options.header) ? options.header : null;
  const want = header ? Math.min(top, offsetWithin(container, header)) : top;

  if (want - padTop < container.scrollTop) {
    container.scrollTop = Math.max(0, want - padTop);
  } else if (bottom + padBottom > container.scrollTop + view) {
    container.scrollTop = bottom + padBottom - view;
  }
}

/**
 * The group header to reveal with `row`: when `row` is the first option of its group, the
 * group's first child if that isn't an option (the label). Works with `role="group"` wrappers.
 */
export function groupHeaderFor(row: HTMLElement): HTMLElement | null {
  const group = row.parentElement;
  if (!group || group.getAttribute("role") !== "group") return null;
  const firstOption = group.querySelector<HTMLElement>('[role="option"]');
  if (firstOption !== row) return null;
  const first = group.firstElementChild as HTMLElement | null;
  return first && first !== row ? first : null;
}

/** Convenience: keep `row` visible in `container`, revealing its group header when first. */
export function keepRowVisible(container: HTMLElement | null | undefined, row: HTMLElement | null | undefined): void {
  if (!row) return;
  scrollRowIntoView(container, row, { header: groupHeaderFor(row) });
}
