import { describe, expect, it } from "vitest";
import { followScrollTop } from "./follow-scroll";

const view = (scrollTop: number, clientHeight = 400, scrollHeight = 2000) => ({ scrollTop, clientHeight, scrollHeight });

describe("followScrollTop", () => {
  it("doesn't scroll while the word is inside the band (15 %–65 %)", () => {
    expect(followScrollTop(view(0), { top: 60, bottom: 85 })).toBeNull();
    expect(followScrollTop(view(300), { top: 200, bottom: 225 })).toBeNull();
    expect(followScrollTop(view(0), { top: 234, bottom: 259 })).toBeNull();
  });

  it("scrolls once the word goes below the band, putting it at the band's top", () => {
    // 65 % of 400 = 260; the word's bottom is past it. Band top = 60.
    expect(followScrollTop(view(0), { top: 250, bottom: 275 })).toBe(190);
    expect(followScrollTop(view(500), { top: 380, bottom: 405 })).toBe(820);
  });

  it("scrolls back up when the word is above the band (e.g. the user scrolled away)", () => {
    expect(followScrollTop(view(800), { top: -300, bottom: -275 })).toBe(440);
    expect(followScrollTop(view(100), { top: 10, bottom: 35 })).toBe(50);
  });

  it("stays within the scrollable range", () => {
    expect(followScrollTop(view(20), { top: 0, bottom: 25 })).toBe(0);
    // Already at the top: nothing to do.
    expect(followScrollTop(view(0), { top: 0, bottom: 25 })).toBeNull();
    expect(followScrollTop(view(1500, 400, 2000), { top: 390, bottom: 415 })).toBe(1600);
    // Already at the bottom: nothing to do.
    expect(followScrollTop(view(1600, 400, 2000), { top: 390, bottom: 415 })).toBeNull();
  });

  it("does nothing for an unsized view", () => {
    expect(followScrollTop(view(0, 0), { top: 500, bottom: 520 })).toBeNull();
  });
});
