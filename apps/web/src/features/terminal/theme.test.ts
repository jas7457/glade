/** Terminal theme from Glade's tokens (I-187): colour parsing and compositing. */
import { describe, expect, it } from "vitest";
import { opaque, parseColor } from "./theme";

describe("terminal theme colours", () => {
  it("parses hex and rgb()/rgba() in comma and space syntax", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255, 1]);
    expect(parseColor("#1e1e1e")).toEqual([30, 30, 30, 1]);
    expect(parseColor("rgba(0, 0, 0, 0.84)")).toEqual([0, 0, 0, 0.84]);
    expect(parseColor("rgb(255 255 255 / 0.82)")).toEqual([255, 255, 255, 0.82]);
    expect(parseColor("rgb(255 255 255 / 50%)")).toEqual([255, 255, 255, 0.5]);
    expect(parseColor("color-mix(in srgb, red, blue)")).toBeNull();
  });

  it("composites translucent text over the background (xterm draws opaque text)", () => {
    expect(opaque("rgba(0, 0, 0, 0.84)", "#ffffff", "#000")).toBe("#292929");
    expect(opaque("rgb(255 255 255 / 0.82)", "#1e1e1e", "#fff")).toBe("#d7d7d7");
    expect(opaque("#007aff", "#ffffff", "#000")).toBe("#007aff");
    expect(opaque("nonsense", "#ffffff", "#123456")).toBe("#123456");
  });
});
