import { describe, expect, it } from "vitest";
import { activeSubagentId, clampPaneSize, cycleTab, isSubagentPaneOpen, mergeLayout, openSubagentPatch, neighbourAfterClose, shouldClearSubagentPane, withoutSession } from "./layout";

describe("workspace layout helpers", () => {
  it("clamps the pane size and defaults to half", () => {
    expect(clampPaneSize(undefined)).toBe(0.5);
    expect(clampPaneSize(Number.NaN)).toBe(0.5);
    expect(clampPaneSize(0.05)).toBe(0.2);
    expect(clampPaneSize(0.95)).toBe(0.8);
    expect(clampPaneSize(0.35)).toBe(0.35);
  });

  it("picks the saved sub-agent tab when it still exists, else the first", () => {
    const layout = { activeSubagentSessionId: { m1: "b" } };
    expect(activeSubagentId(layout, "m1", ["a", "b"])).toBe("b");
    expect(activeSubagentId(layout, "m1", ["a", "c"])).toBe("a");
    expect(activeSubagentId(layout, "m2", ["x"])).toBe("x");
    expect(activeSubagentId(null, "m1", [])).toBeNull();
  });

  it("cycles tabs with wrap-around", () => {
    expect(cycleTab(["a", "b", "c"], "c", 1)).toBe("a");
    expect(cycleTab(["a", "b", "c"], "a", -1)).toBe("c");
    expect(cycleTab(["a", "b"], "a", 1)).toBe("b");
    expect(cycleTab(["a"], "gone", 1)).toBe("a");
    expect(cycleTab([], null, 1)).toBeNull();
  });

  it("focuses the right neighbour after closing, else the left", () => {
    expect(neighbourAfterClose(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourAfterClose(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourAfterClose(["a"], "a")).toBeNull();
  });

  it("merges patches, including the per-main-tab sub-agent map", () => {
    const merged = mergeLayout({ mainOrder: ["a"], activeSubagentSessionId: { a: "x" } }, { activeSubagentSessionId: { b: "y" }, subagentPaneSize: 0.4 });
    expect(merged).toEqual({ mainOrder: ["a"], activeSubagentSessionId: { a: "x", b: "y" }, subagentPaneSize: 0.4 });
    expect(mergeLayout(null, { activeMainSessionId: "a" })).toEqual({ activeMainSessionId: "a" });
  });

  it("forgets a closed session everywhere", () => {
    const layout = withoutSession(
      { mainOrder: ["a", "b"], activeMainSessionId: "b", activeSubagentSessionId: { b: "x", a: "y" }, subagentPaneSize: 0.3 },
      "b",
    );
    expect(layout).toEqual({ mainOrder: ["a"], activeMainSessionId: null, activeSubagentSessionId: { a: "y" }, subagentPaneSize: 0.3 });
    expect(withoutSession({ activeSubagentSessionId: { a: "y" } }, "y").activeSubagentSessionId).toEqual({});
  });

  it("keeps the sub-agent pane closed unless opened; opening focuses the agent (I-080)", () => {
    expect(isSubagentPaneOpen(null)).toBe(false);
    expect(isSubagentPaneOpen({ activeSubagentSessionId: { m1: "a" } })).toBe(false);
    const opened = mergeLayout({ subagentPaneSize: 0.3, activeSubagentSessionId: { m2: "x" } }, openSubagentPatch("m1", "b"));
    expect(opened).toEqual({ subagentPaneSize: 0.3, subagentPaneOpen: true, activeSubagentSessionId: { m2: "x", m1: "b" } });
    expect(isSubagentPaneOpen(opened)).toBe(true);
    expect(isSubagentPaneOpen(mergeLayout(opened, { subagentPaneOpen: false }))).toBe(false);
  });
});

describe("shouldClearSubagentPane (I-085)", () => {
  const open = openSubagentPatch("main", "a1");
  it("clears the saved flag once the pane has no agents left", () => {
    expect(shouldClearSubagentPane(open, true, 0)).toBe(true);
  });
  it("keeps it while agents remain, while loading, or when already closed", () => {
    expect(shouldClearSubagentPane(open, true, 2)).toBe(false);
    expect(shouldClearSubagentPane(open, false, 0)).toBe(false);
    expect(shouldClearSubagentPane({ subagentPaneOpen: false }, true, 0)).toBe(false);
    expect(shouldClearSubagentPane(undefined, true, 0)).toBe(false);
  });
});
