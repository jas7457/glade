import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage, UsageLimits } from "@pi-ui/protocol";
import { UsageLimitsPoller } from "../src/services/usage-limits.js";

function limits(percent: number): UsageLimits {
  return {
    source: "Claude subscription",
    fetchedAt: Date.now(),
    stale: false,
    limits: [{ id: "session", label: "Current session", percent, resetsAt: null, severity: "normal", active: true }],
  };
}

function setup(results: Array<UsageLimits | null | Error | (() => Promise<UsageLimits | null>)>) {
  const queue = [...results];
  const fetchLimits = vi.fn(async (): Promise<UsageLimits | null> => {
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next;
  });
  const sent: ServerMessage[] = [];
  const poller = new UsageLimitsPoller({ fetchLimits, broadcast: (m) => sent.push(m) });
  const pushed = () => sent.map((m) => (m.type === "usage_limits" ? m.usage && [m.usage.limits[0]!.percent, m.usage.stale] : null));
  return { poller, fetchLimits, sent, pushed };
}

describe("UsageLimitsPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("polls only while started and at least one client is connected", async () => {
    const { poller, fetchLimits } = setup([limits(10)]);
    poller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchLimits).not.toHaveBeenCalled();

    poller.setClientCount(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchLimits).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchLimits).toHaveBeenCalledTimes(2);

    poller.setClientCount(0);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchLimits).toHaveBeenCalledTimes(2);

    poller.setClientCount(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchLimits).toHaveBeenCalledTimes(3);
    poller.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchLimits).toHaveBeenCalledTimes(3);
  });

  it("pushes only when the value changes and exposes current()", async () => {
    const { poller, pushed } = setup([limits(10), limits(10), limits(12)]);
    poller.setClientCount(1);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.current()?.limits[0]?.percent).toBe(10);
    await vi.advanceTimersByTimeAsync(60_000); // same value
    await vi.advanceTimersByTimeAsync(60_000); // 12
    expect(pushed()).toEqual([[10, false], [12, false]]);
  });

  it("re-pushes an unchanged value after the heartbeat so fetchedAt stays fresh", async () => {
    const { poller, pushed } = setup([limits(10)]);
    poller.setClientCount(1);
    poller.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(pushed()).toEqual([[10, false], [10, false]]);
  });

  it("keeps the last good value as stale on failure, pushed once, and recovers", async () => {
    const { poller, pushed } = setup([limits(10), null, new Error("boom"), limits(11)]);
    poller.setClientCount(1);
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000); // null → stale
    expect(poller.current()).toMatchObject({ stale: true });
    await vi.advanceTimersByTimeAsync(60_000); // throw → still stale, no push
    await vi.advanceTimersByTimeAsync(60_000); // recovers
    expect(pushed()).toEqual([[10, false], [10, true], [11, false]]);
  });

  it("never pushes when limits are unavailable (feature hidden)", async () => {
    const { poller, sent } = setup([null]);
    poller.setClientCount(1);
    poller.start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(sent).toEqual([]);
    expect(poller.current()).toBeNull();
  });

  it("coalesces concurrent refreshes and rate-limits unforced ones", async () => {
    let resolve!: (v: UsageLimits) => void;
    const { poller, fetchLimits } = setup([() => new Promise<UsageLimits>((r) => (resolve = r))]);
    const a = poller.refresh();
    const b = poller.refresh(true);
    expect(a).toBe(b);
    resolve(limits(5));
    await a;
    expect(fetchLimits).toHaveBeenCalledTimes(1);

    await poller.refresh(); // < 15s later → skipped
    expect(fetchLimits).toHaveBeenCalledTimes(1);
    const next = poller.refresh(true);
    resolve(limits(6));
    await next;
    expect(fetchLimits).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(15_000);
    const later = poller.refresh();
    resolve(limits(7));
    await later;
    expect(fetchLimits).toHaveBeenCalledTimes(3);
  });

  it("refreshes after a run ends, deferring to respect the minimum interval", async () => {
    const { poller, fetchLimits } = setup([limits(10)]);
    poller.onRunEnd(); // not active → ignored
    expect(fetchLimits).not.toHaveBeenCalled();

    poller.setClientCount(1);
    poller.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchLimits).toHaveBeenCalledTimes(1);

    poller.onRunEnd();
    poller.onRunEnd();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetchLimits).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchLimits).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(20_000);
    poller.onRunEnd(); // > 15s since last fetch → immediate
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchLimits).toHaveBeenCalledTimes(3);
  });
});
