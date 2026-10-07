import { describe, expect, it } from "vitest";
import { compareListOrder, topSortOrder } from "./chat-order";

describe("chat list order (I-202)", () => {
  it("sorts by sortOrder; items without one first (newest first); ties newest first", () => {
    const items = [
      { id: "b", sortOrder: 1, createdAt: 1 },
      { id: "a", sortOrder: 0, createdAt: 1 },
      { id: "old", createdAt: 1 },
      { id: "new", createdAt: 5 },
      { id: "tieNew", sortOrder: 1, createdAt: 9 },
    ];
    expect([...items].sort(compareListOrder).map((i) => i.id)).toEqual(["new", "old", "a", "tieNew", "b"]);
  });

  it("topSortOrder is one below the lowest number (0 when empty)", () => {
    expect(topSortOrder([])).toBe(0);
    expect(topSortOrder([{ id: "x", createdAt: 1 }])).toBe(0);
    expect(topSortOrder([{ id: "x", sortOrder: 3, createdAt: 1 }, { id: "y", sortOrder: -2, createdAt: 1 }])).toBe(-3);
  });
});
