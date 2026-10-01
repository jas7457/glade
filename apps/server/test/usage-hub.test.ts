import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage, UsageLimits } from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import type { AgentHarness } from "../src/harness/types.js";
import { UsageLimitsHub } from "../src/services/usage-hub.js";

function limits(source: string, percent: number): UsageLimits {
  return { source, provider: "fake", fetchedAt: Date.now(), stale: false, limits: [{ id: "s", label: "Session", percent, resetsAt: null, severity: "normal", active: true }] };
}

function fake(id: string, read: () => UsageLimits | null): FakeHarness {
  return new FakeHarness(undefined, 0, { id, label: id.toUpperCase(), usageLimits: read });
}

describe("UsageLimitsHub (I-191)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  function setup(list: AgentHarness[], opts: { offered?: Set<string>; defaultId?: string } = {}) {
    const sent: ServerMessage[] = [];
    const hub = new UsageLimitsHub({
      harnesses: () => list,
      isOffered: (h) => !opts.offered || opts.offered.has(h.id),
      defaultId: () => opts.defaultId ?? list[0]!.id,
      broadcast: (m) => sent.push(m),
    });
    const entries = (m: ServerMessage | undefined) => (m?.type === "usage_limits" ? m.entries?.map((e) => `${e.harnessId}:${e.usage.limits[0]!.percent}`) : null);
    return { hub, sent, entries };
  }

  it("is disabled when no harness reports limits", () => {
    const { hub } = setup([new FakeHarness()]);
    expect(hub.enabled).toBe(false);
    expect(hub.message()).toBeNull();
  });

  it("broadcasts every agent's entry, the default first, on each agent's change", async () => {
    let bPercent = 20;
    const { hub, sent, entries } = setup([fake("a", () => limits("A", 10)), fake("b", () => limits("B", bPercent))], { defaultId: "b" });
    hub.start();
    hub.setClientCount(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(entries(sent.at(-1))).toEqual(["b:20", "a:10"]);
    const msg = sent.at(-1);
    expect(msg?.type === "usage_limits" && msg.usage?.source).toBe("B");
    bPercent = 25;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(entries(sent.at(-1))).toEqual(["b:25", "a:10"]);
    hub.stop();
  });

  it("doesn't read agents that aren't offered and leaves them out", async () => {
    const read = vi.fn(() => limits("C", 30));
    const offered = new Set(["a"]);
    const { hub } = setup([fake("a", () => limits("A", 10)), fake("c", read)], { offered });
    hub.start();
    hub.setClientCount(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).not.toHaveBeenCalled();
    expect(hub.entries().map((e) => e.harnessId)).toEqual(["a"]);
    offered.add("c");
    await hub.refresh(true);
    expect(hub.entries().map((e) => e.harnessId)).toEqual(["a", "c"]);
    offered.delete("c");
    expect(hub.entries().map((e) => e.harnessId)).toEqual(["a"]);
    hub.stop();
  });

  it("respects a harness's own polling interval", async () => {
    const read = vi.fn(() => limits("S", 1));
    const slow = fake("slow", read);
    Object.assign(slow, { usageLimitsPolling: { intervalMs: 300_000, minIntervalMs: 60_000 } });
    const fast = vi.fn(() => limits("F", 1));
    const { hub } = setup([fake("fast", fast), slow]);
    hub.start();
    hub.setClientCount(1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(fast).toHaveBeenCalledTimes(5);
    expect(read).toHaveBeenCalledTimes(1);
    hub.onRunEnd(); // a run ended: read again (the last read was over a minute ago)
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    hub.onRunEnd(); // again right away: waits for the harness's minimum interval
    await vi.advanceTimersByTimeAsync(59_000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(3);
    hub.stop();
  });
});
