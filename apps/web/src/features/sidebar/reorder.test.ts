import { describe, expect, it } from "vitest";
import { autoScrollDelta, dropLineEdge, isNoopDrop, mergeVisibleOrder, moveToGap, passedThreshold, resolveDropGap, resolveTreeDrop, shiftYOf, visibleEntryCount, type TreeRowRect } from "./reorder";

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

describe("resolveTreeDrop (I-202)", () => {
  // Rows 30px high, 2px apart: a, [F: f1, f2], b, [G closed], c
  const row = (id: string, kind: "chat" | "folder", parent: string | null, i: number, open?: boolean): TreeRowRect => ({ id, kind, parent, open, top: i * 32, bottom: i * 32 + 30 });
  const rows: TreeRowRect[] = [
    row("a", "chat", null, 0),
    row("F", "folder", null, 1, true),
    row("f1", "chat", "F", 2),
    row("f2", "chat", "F", 3),
    row("b", "chat", null, 4),
    row("G", "folder", null, 5, false),
    row("c", "chat", null, 6),
  ];
  // The pointer over row i at `frac` of its height.
  const at = (i: number, frac: number) => i * 32 + 30 * frac;

  it("reorders top-level chats around folders", () => {
    const drop = resolveTreeDrop(rows, "c", at(0, 0.2));
    expect(drop).toMatchObject({ parent: null, order: ["c", "a", "F", "b", "G"], line: { id: "a", edge: "top", depth: 0 } });
    expect(drop?.shifted).toEqual(["a", "F", "f1", "f2", "b", "G"]);
    expect(resolveTreeDrop(rows, "a", at(6, 0.9))).toMatchObject({ parent: null, order: ["F", "b", "G", "c", "a"], line: { id: "c", edge: "bottom", depth: 0 } });
  });

  it("the lower half of an open folder's row goes into it, at its top", () => {
    expect(resolveTreeDrop(rows, "a", at(1, 0.8))).toMatchObject({ parent: "F", order: ["a", "f1", "f2"], line: { id: "f1", edge: "top", depth: 1 } });
  });

  it("between a folder's chats goes into it; under its last chat depends on the row the pointer is over", () => {
    expect(resolveTreeDrop(rows, "b", at(2, 0.8))).toMatchObject({ parent: "F", order: ["f1", "b", "f2"] });
    // Lower half of f2: end of the folder (line at depth 1 on top of b).
    expect(resolveTreeDrop(rows, "c", at(3, 0.8))).toMatchObject({ parent: "F", order: ["f1", "f2", "c"], line: { id: "b", edge: "top", depth: 1 } });
    // Upper half of b: top level, after the folder.
    expect(resolveTreeDrop(rows, "c", at(4, 0.2))).toMatchObject({ parent: null, order: ["a", "F", "c", "b", "G"], line: { id: "b", edge: "top", depth: 0 } });
  });

  it("drags a chat out of its folder and reorders inside it", () => {
    expect(resolveTreeDrop(rows, "f1", at(0, 0.2))).toMatchObject({ parent: null, order: ["f1", "a", "F", "b", "G", "c"] });
    expect(resolveTreeDrop(rows, "f1", at(3, 0.8))).toMatchObject({ parent: "F", order: ["f2", "f1"] });
  });

  it("a closed folder's row is a top-level neighbour (into it is the folder-row target's job)", () => {
    expect(resolveTreeDrop(rows, "a", at(5, 0.8))).toMatchObject({ parent: null, order: ["F", "b", "G", "a", "c"] });
  });

  it("returns null where nothing would change", () => {
    expect(resolveTreeDrop(rows, "b", at(4, 0.3))).toBeNull();
    expect(resolveTreeDrop(rows, "f2", at(3, 0.7))).toBeNull();
    expect(resolveTreeDrop(rows, "nope", 0)).toBeNull();
  });

  it("folders move between top-level blocks only, with their chats", () => {
    const drop = resolveTreeDrop(rows, "F", at(6, 0.9));
    expect(drop).toMatchObject({ parent: null, order: ["a", "b", "G", "c", "F"], line: { id: "c", edge: "bottom", depth: 0 } });
    // Dropped where the folder already is (its own chats don't count as places).
    expect(resolveTreeDrop(rows, "F", at(2, 0.5))).toBeNull();
    expect(resolveTreeDrop(rows, "G", at(1, 0.2))).toMatchObject({ order: ["a", "G", "F", "b", "c"], shifted: ["F", "f1", "f2", "b", "c"] });
  });
});

describe("visibleEntryCount", () => {
  const holds = (ids: string[]) => ids.map((id) => (x: string) => x === id || x === `${id}-child`);
  it("shows the limit, all when expanded, and reaches an entry holding the selection", () => {
    expect(visibleEntryCount(holds(["a", "b", "c", "d"]), 2, false, null)).toBe(2);
    expect(visibleEntryCount(holds(["a", "b", "c", "d"]), 2, true, null)).toBe(4);
    expect(visibleEntryCount(holds(["a", "b", "c", "d"]), 2, false, "c-child")).toBe(3);
  });
});

describe("shiftYOf", () => {
  it("reads the translate and transform offsets", () => {
    expect(shiftYOf("0px 6px", "none")).toBe(6);
    expect(shiftYOf("none", "matrix(1, 0, 0, 1, 0, 3.5)")).toBe(3.5);
    expect(shiftYOf("", "")).toBe(0);
  });
});
