import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "preact";
import { act, render, screen } from "@testing-library/preact";
import { advance, DRAIN_MS, retarget, revealedText, useSmoothText, type RevealState } from "./smooth-text";

const start: RevealState = { shown: 0, target: 0, rate: 0 };

describe("smooth text reveal", () => {
  it("drains a big delta linearly over DRAIN_MS", () => {
    let s = retarget(start, 400);
    s = advance(s, DRAIN_MS / 4);
    expect(s.shown).toBeCloseTo(100);
    s = advance(s, DRAIN_MS / 4);
    expect(s.shown).toBeCloseTo(200);
    s = advance(s, DRAIN_MS);
    expect(s.shown).toBe(400);
    expect(advance(s, 16)).toBe(s);
  });

  it("re-plans the remaining backlog when more text arrives", () => {
    let s = advance(retarget(start, 100), DRAIN_MS / 2); // 50 shown
    s = retarget(s, 250); // 200 left → drained in DRAIN_MS from now
    expect(s.shown).toBeCloseTo(50);
    expect(advance(s, DRAIN_MS).shown).toBe(250);
    expect(advance(s, DRAIN_MS / 2).shown).toBeCloseTo(150);
  });

  it("clamps when the text shrinks (replaced)", () => {
    const s = retarget({ shown: 80, target: 100, rate: 1 }, 30);
    expect(s).toEqual({ shown: 30, target: 30, rate: 0 });
  });

  it("reveals a prefix without splitting surrogate pairs", () => {
    expect(revealedText("hello", 2.7)).toBe("he");
    expect(revealedText("hello", 99)).toBe("hello");
    expect(revealedText("a😀b", 2)).toBe("a😀");
    expect(revealedText("hello", 0)).toBe("");
  });
});

function Probe({ text, streaming }: { text: string; streaming: boolean }) {
  return h("p", { "data-testid": "probe" }, useSmoothText(text, streaming));
}

describe("useSmoothText", () => {
  afterEach(() => vi.useRealTimers());
  const shown = () => screen.getByTestId("probe").textContent ?? "";

  it("shows history (not streaming) in full at once", () => {
    render(h(Probe, { text: "Hello there", streaming: false }));
    expect(shown()).toBe("Hello there");
  });

  it("reveals a first big delta progressively and finishes the reveal after streaming stops", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const text = "x".repeat(200);
    const { rerender } = render(h(Probe, { text, streaming: true }));
    expect(shown()).toBe("");
    await act(async () => void vi.advanceTimersByTime(DRAIN_MS / 2));
    expect(shown().length).toBeGreaterThan(50);
    expect(shown().length).toBeLessThan(150);
    rerender(h(Probe, { text: text + "yz", streaming: false }));
    // A reply that ends right after its only big delta still streams in (no snap to full)...
    expect(shown().length).toBeLessThan(text.length);
    // ...and is complete within DRAIN_MS.
    await act(async () => void vi.advanceTimersByTime(DRAIN_MS + 50));
    expect(shown()).toBe(text + "yz");
  });

  it("catches up within DRAIN_MS of the last delta", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const { rerender } = render(h(Probe, { text: "Hello", streaming: true }));
    await act(async () => void vi.advanceTimersByTime(DRAIN_MS / 2));
    rerender(h(Probe, { text: "Hello, world and more", streaming: true }));
    await act(async () => void vi.advanceTimersByTime(DRAIN_MS + 50));
    expect(shown()).toBe("Hello, world and more");
  });
});
