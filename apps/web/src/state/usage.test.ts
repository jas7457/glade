import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageLimit, UsageLimits } from "@pi-ui/protocol";
import {
  formatPercent,
  formatResetsAt,
  formatUpdatedAgo,
  handleUsageMessage,
  limitAlerts,
  primaryLimit,
  usageLimits,
} from "./usage";

const limit = (over: Partial<UsageLimit> = {}): UsageLimit => ({
  id: "session",
  label: "Current session",
  percent: 44,
  resetsAt: null,
  severity: "normal",
  active: false,
  ...over,
});
const usage = (limits: UsageLimit[], over: Partial<UsageLimits> = {}): UsageLimits => ({
  source: "Claude subscription",
  limits,
  fetchedAt: 0,
  stale: false,
  ...over,
});

// Local-time reference: Friday 2026-09-25 14:00.
const NOW = new Date(2026, 8, 25, 14, 0).getTime();
const at = (...args: [number, number, number, number, number]) => new Date(...args).toISOString();

describe("formatResetsAt", () => {
  it("shows the time today, weekday + time within a week, else the date", () => {
    expect(formatResetsAt(at(2026, 8, 25, 18, 40), NOW)).toMatch(/^Resets at 6:40\sPM$/);
    expect(formatResetsAt(at(2026, 8, 26, 12, 0), NOW)).toMatch(/^Resets Saturday 12:00\sPM$/);
    expect(formatResetsAt(at(2026, 9, 1, 9, 5), NOW)).toMatch(/^Resets Thursday 9:05\sAM$/);
    expect(formatResetsAt(at(2026, 9, 2, 12, 0), NOW)).toMatch(/^Resets Oct 2, 12:00\sPM$/);
    expect(formatResetsAt(at(2027, 0, 3, 9, 0), NOW)).toMatch(/^Resets Jan 3, 2027, 9:00\sAM$/);
  });

  it("rounds to the nearest minute", () => {
    expect(formatResetsAt(new Date(2026, 8, 25, 18, 39, 59, 874).toISOString(), NOW)).toMatch(/^Resets at 6:40\sPM$/);
  });

  it("handles unknown/invalid values", () => {
    expect(formatResetsAt(null, NOW)).toBeNull();
    expect(formatResetsAt("nope", NOW)).toBeNull();
  });
});

describe("formatUpdatedAgo / formatPercent", () => {
  it("formats", () => {
    expect(formatUpdatedAgo(NOW - 20_000, NOW)).toBe("Updated just now");
    expect(formatUpdatedAgo(NOW - 2 * 60_000, NOW)).toBe("Updated 2 min ago");
    expect(formatUpdatedAgo(NOW - 3 * 3_600_000, NOW)).toBe("Updated 3 hr ago");
    expect(formatPercent(43.6)).toBe("44%");
  });
});

describe("primaryLimit", () => {
  it("prefers worst severity, then the active limit, then the fullest", () => {
    const session = limit({ percent: 44, active: true });
    const week = limit({ id: "weekly_all", percent: 60 });
    expect(primaryLimit([week, session])).toBe(session);
    expect(primaryLimit([limit({ percent: 5 }), week])).toBe(week);
    const warn = limit({ id: "weekly_all", percent: 30, severity: "warning" });
    expect(primaryLimit([session, warn])).toBe(warn);
    expect(primaryLimit([])).toBeNull();
  });
});

describe("limitAlerts / handleUsageMessage", () => {
  beforeEach(() => {
    usageLimits.value = null;
  });

  it("alerts only on escalation or a non-normal limit becoming active", () => {
    const prev = usage([limit({ severity: "normal" }), limit({ id: "w", severity: "warning" })]);
    expect(limitAlerts(null, usage([limit({ severity: "critical" })]))).toEqual([]);
    expect(limitAlerts(prev, usage([limit({ severity: "warning" }), limit({ id: "w", severity: "warning" })])).map((l) => l.id)).toEqual(["session"]);
    expect(limitAlerts(prev, usage([limit(), limit({ id: "w", severity: "critical" })])).map((l) => l.id)).toEqual(["w"]);
    expect(limitAlerts(prev, usage([limit({ active: true }), limit({ id: "w", severity: "warning", active: true })])).map((l) => l.id)).toEqual(["w"]);
    expect(limitAlerts(prev, prev)).toEqual([]);
  });

  it("sets the signal and toasts once per transition, never for stale values", () => {
    const notify = vi.fn();
    handleUsageMessage(usage([limit()]), notify, NOW);
    expect(usageLimits.value?.limits[0]?.percent).toBe(44);
    const critical = usage([limit({ percent: 96, severity: "critical", resetsAt: at(2026, 8, 25, 18, 40) })]);
    handleUsageMessage(critical, notify, NOW);
    handleUsageMessage(critical, notify, NOW);
    handleUsageMessage({ ...critical, stale: true }, notify, NOW);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ level: "error", title: "Current session: limit almost reached" });
    expect(notify.mock.calls[0]![0].message).toMatch(/96% of your Claude subscription limit used\. Resets at 6:40\sPM\./);
    handleUsageMessage(null, notify, NOW);
    expect(usageLimits.value).toBeNull();
  });
});
