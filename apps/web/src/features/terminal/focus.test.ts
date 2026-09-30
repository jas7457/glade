/** ⌘K in a focused terminal (I-187): the Mac app's menu action clears it instead of opening the palette. */
import { describe, expect, it, vi } from "vitest";
import { clearFocusedTerminal, setFocusedTerminal } from "./focus";

describe("focused terminal", () => {
  it("clears only while a terminal has focus; a stale blur doesn't unset a newer one", () => {
    expect(clearFocusedTerminal()).toBe(false);
    const a = { clear: vi.fn(), focus: vi.fn() };
    const b = { clear: vi.fn(), focus: vi.fn() };
    setFocusedTerminal(a);
    setFocusedTerminal(b);
    setFocusedTerminal(null, a); // a's blur arrives after b's focus
    expect(clearFocusedTerminal()).toBe(true);
    expect(b.clear).toHaveBeenCalledOnce();
    expect(a.clear).not.toHaveBeenCalled();
    setFocusedTerminal(null, b);
    expect(clearFocusedTerminal()).toBe(false);
  });
});
