import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "preact";
import { act, render, screen } from "@testing-library/preact";
import { advance, drainTime, DRAIN_MS, MAX_DRAIN_MS, REVEAL_CHARS_PER_MS, retarget, revealedText, useSmoothText, type RevealState } from "./smooth-text";

const start: RevealState = { shown: 0, target: 0, rate: 0 };

describe("smooth text reveal", () => {
  it("drains a backlog linearly over the given time", () => {
    let s = retarget(start, 400, DRAIN_MS);
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

  it("paces big backlogs (I-079): small ones in DRAIN_MS, bursts at REVEAL_CHARS_PER_MS, never over MAX_DRAIN_MS", () => {
    expect(drainTime(50)).toBe(DRAIN_MS);
    expect(drainTime(2000)).toBe(2000 / REVEAL_CHARS_PER_MS);
    expect(drainTime(50_000)).toBe(MAX_DRAIN_MS);
    // A 2000-char burst (Opus after thinking) is still being revealed half a second later.
    const s = retarget(start, 2000);
    expect(advance(s, 500).shown).toBeCloseTo(500 * REVEAL_CHARS_PER_MS);
    expect(advance(s, drainTime(2000)).shown).toBe(2000);
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

  it("paces a burst that arrives after the reply started (I-079)", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const { rerender } = render(h(Probe, { text: "Hi", streaming: true }));
    await act(async () => void vi.advanceTimersByTime(DRAIN_MS));
    const burst = "Hi" + "x".repeat(2000);
    rerender(h(Probe, { text: burst, streaming: true }));
    await act(async () => void vi.advanceTimersByTime(DRAIN_MS));
    // Not popped in within DRAIN_MS: still well short of the burst.
    expect(shown().length).toBeLessThan(500);
    await act(async () => void vi.advanceTimersByTime(drainTime(2000)));
    expect(shown()).toBe(burst);
  });

  it("catches up text that was already there when it mounted mid-stream within DRAIN_MS", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    const text = "y".repeat(1500);
    render(h(Probe, { text, streaming: true }));
    await act(async () => void vi.advanceTimersByTime(DRAIN_MS + 50));
    expect(shown()).toBe(text);
  });
});
