import { describe, expect, it } from "vitest";
import { autoScrollDelta, dropLineEdge, isNoopDrop, mergeVisibleOrder, moveToGap, passedThreshold, resolveDropGap } from "./reorder";

const rects = [
  { top: 0, bottom: 30 },
  { top: 32, bottom: 62 },
  { top: 64, bottom: 200 }, // a tall (expanded) project group
];

describe("resolveDropGap", () => {
  it("counts items whose midpoint is above the pointer", () => {
    expect(resolveDropGap(rects, -10)).toBe(0);
    expect(resolveDropGap(rects, 14)).toBe(0);
    expect(resolveDropGap(rects, 16)).toBe(1);
    expect(resolveDropGap(rects, 50)).toBe(2);
    expect(resolveDropGap(rects, 131)).toBe(2);
    expect(resolveDropGap(rects, 133)).toBe(3);
    expect(resolveDropGap(rects, 999)).toBe(3);
  });
  it("handles an empty list", () => {
    expect(resolveDropGap([], 10)).toBe(0);
  });
});

describe("moveToGap", () => {
  const ids = ["a", "b", "c", "d"];
  it("moves down (gap counts the item's own slot)", () => {
    expect(moveToGap(ids, 0, 2)).toEqual(["b", "a", "c", "d"]);
    expect(moveToGap(ids, 0, 4)).toEqual(["b", "c", "d", "a"]);
  });
  it("moves up", () => {
    expect(moveToGap(ids, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveToGap(ids, 2, 1)).toEqual(["a", "c", "b", "d"]);
  });
  it("returns null for no-op or invalid drops", () => {
    expect(moveToGap(ids, 1, 1)).toBeNull();
    expect(moveToGap(ids, 1, 2)).toBeNull();
    expect(moveToGap(ids, -1, 2)).toBeNull();
    expect(moveToGap(ids, 0, 5)).toBeNull();
    expect(isNoopDrop(2, 3)).toBe(true);
    expect(isNoopDrop(2, 0)).toBe(false);
  });
  it("does not mutate the input", () => {
    moveToGap(ids, 0, 3);
    expect(ids).toEqual(["a", "b", "c", "d"]);
  });
});

describe("autoScrollDelta", () => {
  const box = { top: 100, bottom: 500 };
  it("is zero away from the edges", () => {
    expect(autoScrollDelta(300, box)).toBe(0);
  });
  it("scrolls up near the top and down near the bottom, faster closer to the edge", () => {
    expect(autoScrollDelta(130, box)).toBeLessThan(0);
    expect(autoScrollDelta(100, box)).toBe(-14);
    expect(autoScrollDelta(50, box)).toBe(-14);
    expect(autoScrollDelta(480, box)).toBeGreaterThan(0);
    expect(autoScrollDelta(490, box)).toBeGreaterThan(autoScrollDelta(470, box));
  });
});

describe("passedThreshold", () => {
  it("needs a few pixels of movement", () => {
    expect(passedThreshold(1, 2)).toBe(false);
    expect(passedThreshold(3, 3)).toBe(true);
  });
});

describe("dropLineEdge", () => {
  it("draws above the item after the gap, or below the last item", () => {
    expect(dropLineEdge(1, 1, 3)).toBe("top");
    expect(dropLineEdge(0, 1, 3)).toBeNull();
    expect(dropLineEdge(2, 3, 3)).toBe("bottom");
    expect(dropLineEdge(1, 3, 3)).toBeNull();
    expect(dropLineEdge(0, null, 3)).toBeNull();
  });
});

describe("mergeVisibleOrder", () => {
  it("keeps hidden items after the reordered visible ones", () => {
    expect(mergeVisibleOrder(["a", "b", "c", "d"], ["b", "a"])).toEqual(["b", "a", "c", "d"]);
    expect(mergeVisibleOrder(["a", "b"], ["b", "a", "zombie"])).toEqual(["b", "a"]);
  });
});
