import { describe, expect, it } from "vitest";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, clampSidebarWidth, readStored, resolveSidebarDrag } from "./ui";

describe("clampSidebarWidth", () => {
  it("keeps widths inside [min, max]", () => {
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(300.4)).toBe(300);
  });
  it("falls back to the default for garbage", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(Number("abc"))).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

describe("resolveSidebarDrag", () => {
  it("resizes and clamps", () => {
    expect(resolveSidebarDrag(260, 40)).toEqual({ width: 300, collapsed: false });
    expect(resolveSidebarDrag(260, 500)).toEqual({ width: SIDEBAR_MAX_WIDTH, collapsed: false });
    expect(resolveSidebarDrag(260, -80)).toEqual({ width: SIDEBAR_MIN_WIDTH, collapsed: false });
  });
  it("collapses when dragged far left, keeping the previous width", () => {
    expect(resolveSidebarDrag(260, -200)).toEqual({ width: 260, collapsed: true });
  });
});

describe("readStored (I-059 rename)", () => {
  it("prefers the glade.* key and falls back to the old pi-ui.* key once", () => {
    localStorage.clear();
    localStorage.setItem("pi-ui.sidebar.width", "310");
    expect(readStored("glade.sidebar.width")).toBe("310");
    localStorage.setItem("glade.sidebar.width", "280");
    expect(readStored("glade.sidebar.width")).toBe("280");
    expect(readStored("glade.missing")).toBeNull();
    localStorage.clear();
  });
});
