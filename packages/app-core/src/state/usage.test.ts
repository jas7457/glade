import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessUsageLimits, UsageLimit, UsageLimits } from "@glade/protocol";
import {
  formatPercent,
  formatResetsAt,
  formatUpdatedAgo,
  handleUsageMessage,
  limitAlerts,
  limitMatchesModel,
  primaryLimit,
  usageForChat,
  usageLimits,
  usageLimitsOf,
} from "./usage";
import { hasLocalEnvironment, localEnvironmentId } from "./env-registry";

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
  provider: "anthropic",
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
    expect(formatResetsAt(at(2026, 9, 2, 12, 0), NOW)).toMatch(/^Resets Friday 12:00\sPM$/); // exactly 7 days away
    expect(formatResetsAt(at(2026, 9, 2, 23, 59), NOW)).toMatch(/^Resets Friday 11:59\sPM$/);
    expect(formatResetsAt(at(2026, 9, 3, 0, 5), NOW)).toMatch(/^Resets Oct 3, 12:05\sAM$/);
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
    usageLimits.value = new Map();
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
    const msg = (u: UsageLimits) => ({ usage: u, entries: [{ harnessId: "pi", label: "Pi", usage: u }] });
    handleUsageMessage(msg(usage([limit()])), undefined, notify, NOW);
    expect(usageLimitsOf(undefined)[0]?.usage.limits[0]?.percent).toBe(44);
    const critical = usage([limit({ percent: 96, severity: "critical", resetsAt: at(2026, 8, 25, 18, 40) })]);
    handleUsageMessage(msg(critical), undefined, notify, NOW);
    handleUsageMessage(msg(critical), undefined, notify, NOW);
    handleUsageMessage(msg({ ...critical, stale: true }), undefined, notify, NOW);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({ level: "error", title: "Current session: limit almost reached" });
    expect(notify.mock.calls[0]![0].message).toMatch(/96% of your Claude subscription limit used\. Resets at 6:40\sPM\./);
    handleUsageMessage({ usage: null, entries: [] }, undefined, notify, NOW);
    expect(usageLimitsOf(undefined)).toEqual([]);
  });

  it("I-191: compares each agent with its own previous limits", () => {
    const notify = vi.fn();
    const warn = usage([limit({ percent: 80, severity: "warning" })], { source: "Codex (plus)" });
    handleUsageMessage({ usage: null, entries: [{ harnessId: "pi", label: "Pi", usage: warn }, { harnessId: "codex", label: "Codex", usage: usage([limit()], { source: "Codex (plus)" }) }] }, undefined, notify, NOW);
    // Codex escalates (pi already was at warning): one toast, Codex's.
    handleUsageMessage({ usage: null, entries: [{ harnessId: "pi", label: "Pi", usage: warn }, { harnessId: "codex", label: "Codex", usage: warn }] }, undefined, notify, NOW);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].message).toContain("Codex (plus)");
  });

  it("reads an older server's message (only the default agent's `usage`)", () => {
    handleUsageMessage({ usage: usage([limit()]) }, undefined, vi.fn(), NOW);
    expect(usageLimitsOf(undefined).map((e) => [e.harnessId, e.label])).toEqual([["", "Claude subscription"]]);
    handleUsageMessage({ usage: usage([]) }, undefined, vi.fn(), NOW);
    expect(usageLimitsOf(undefined)).toEqual([]);
  });
});

describe("usageForChat (I-195)", () => {
  const entry = (harnessId: string, provider: string, limits = [limit()]): HarnessUsageLimits => ({ harnessId, label: harnessId, usage: usage(limits, { provider }) });
  const all = [entry("pi", "anthropic"), entry("claude", "anthropic"), entry("codex", "codex"), entry("empty", "x", [])];
  const ids = (list: ReturnType<typeof usageForChat>) => list.map((e) => e.harnessId);

  it("returns only the chat's own agent when its limits apply to the chat's model", () => {
    expect(ids(usageForChat(all, "codex", { provider: "codex", id: "gpt-6" }))).toEqual(["codex"]);
    expect(ids(usageForChat(all, "claude", { provider: "anthropic", id: "claude-sonnet-4-5" }))).toEqual(["claude"]);
    expect(ids(usageForChat(all, "claude", null))).toEqual(["claude"]);
  });

  it("returns nothing when the chat's agent has no limits or they don't apply to its model", () => {
    expect(ids(usageForChat(all, "pi", { provider: "openai", id: "gpt-5" }))).toEqual([]);
    expect(ids(usageForChat(all, "empty", null))).toEqual([]);
    expect(ids(usageForChat(all, "fake", null))).toEqual([]);
    expect(ids(usageForChat(all, null, null))).toEqual([]);
  });

  it("matches an older server's unnamed entry by the model's provider", () => {
    const legacy = [entry("", "anthropic")];
    expect(ids(usageForChat(legacy, "pi", { provider: "anthropic", id: "x" }))).toEqual([""]);
    expect(ids(usageForChat(legacy, "pi", { provider: "openai", id: "x" }))).toEqual([]);
  });
});

describe("limitMatchesModel", () => {
  const all = usage([limit(), limit({ id: "weekly_scoped:Fable", label: "Fable this week", model: "Fable" })]);

  it("matches per-model limits against the model id", () => {
    const fable = all.limits[1]!;
    expect(limitMatchesModel(fable, { provider: "anthropic", id: "claude-fable-1" })).toBe(true);
    expect(limitMatchesModel(fable, { provider: "anthropic", id: "claude-sonnet-4-5" })).toBe(false);
    expect(limitMatchesModel(limit({ model: "Opus 4" }), { provider: "anthropic", id: "claude-opus-4-1" })).toBe(true);
    expect(limitMatchesModel(all.limits[0]!, { provider: "anthropic", id: "claude-fable-1" })).toBe(false);
    expect(limitMatchesModel(fable, null)).toBe(false);
  });
});

describe("usage per environment (I-191)", () => {
  beforeEach(() => {
    usageLimits.value = new Map();
    localEnvironmentId.value = null;
    hasLocalEnvironment.value = true;
  });

  const msg = (source: string, percent = 44, severity: UsageLimit["severity"] = "normal") => ({
    usage: null,
    entries: [{ harnessId: "pi", label: "Pi", usage: usage([limit({ percent, severity })], { source }) }],
  });

  it("keeps each Mac's limits apart; this device's own server is the untagged one", () => {
    localEnvironmentId.value = "MAC";
    handleUsageMessage(msg("Mine"), "MAC", vi.fn(), NOW);
    handleUsageMessage(msg("Other"), "OTHER", vi.fn(), NOW);
    expect(usageLimitsOf(undefined)[0]?.usage.source).toBe("Mine");
    expect(usageLimitsOf("MAC")[0]?.usage.source).toBe("Mine");
    expect(usageLimitsOf("OTHER")[0]?.usage.source).toBe("Other");
    expect(usageLimitsOf("NEW")).toEqual([]);
  });

  it("toasts for this device's own server, and on a device without one (the iPhone) for every Mac", () => {
    localEnvironmentId.value = "MAC";
    const notify = vi.fn();
    handleUsageMessage(msg("Other"), "OTHER", notify, NOW);
    handleUsageMessage(msg("Other", 96, "critical"), "OTHER", notify, NOW);
    expect(notify).not.toHaveBeenCalled();
    localEnvironmentId.value = null;
    hasLocalEnvironment.value = false;
    handleUsageMessage(msg("Host"), "HOST", notify, NOW);
    handleUsageMessage(msg("Host", 96, "critical"), "HOST", notify, NOW);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
