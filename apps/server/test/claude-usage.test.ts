/**
 * I-191: Claude Code's plan limits from the SDK's experimental `/usage` data, read from a
 * short-lived process (fake SDK; no CLI, no model).
 */
import { describe, expect, it } from "vitest";
import { ClaudeHarness } from "../src/harness/claude/claude-harness.js";
import type { ClaudeQuery, ClaudeQueryParams } from "../src/harness/claude/sdk.js";
import { claudeUsageLimits } from "../src/harness/claude/usage.js";
import { FakeClaudeSdk, type FakeQuery } from "./fixtures/fake-claude-sdk.js";

/** The real CLI's answer, trimmed (2026-10). */
const USAGE = {
  session: { total_cost_usd: 0 },
  subscription_type: "pro",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 3, resets_at: "2026-10-01T18:19:59.790976+00:00" },
    seven_day: { utilization: 63, resets_at: "2026-10-03T15:59:59.790993+00:00" },
    extra_usage: { is_enabled: false },
    limits: [
      { kind: "session", group: "session", percent: 3, severity: "normal", resets_at: "2026-10-01T18:19:59.790976+00:00", scope: null, is_active: false },
      { kind: "weekly_all", group: "weekly", percent: 63, severity: "normal", resets_at: "2026-10-03T15:59:59.790993+00:00", scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 0, severity: "normal", resets_at: null, scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ],
  },
  behaviors: null,
};

class UsageSdk extends FakeClaudeSdk {
  answer: unknown = USAGE;
  asked: Array<{ skipBehaviors?: boolean } | undefined> = [];
  override async query(params: ClaudeQueryParams): Promise<ClaudeQuery> {
    const query = (await super.query(params)) as FakeQuery;
    return Object.assign(query, {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (opts?: { skipBehaviors?: boolean }) => {
        this.asked.push(opts);
        return this.answer;
      },
    });
  }
}

function harness(sdk: FakeClaudeSdk, installed = true) {
  return new ClaudeHarness({ sdk, utilityCwd: "/tmp/scratch", which: () => installed, findExecutable: () => (installed ? "/usr/local/bin/claude" : null), env: { PATH: "/usr/bin" } });
}

describe("Claude Code usage limits (I-191)", () => {
  it("maps the /usage data to the gauge's limits", () => {
    const limits = claudeUsageLimits(USAGE, 5);
    expect(limits).toMatchObject({ source: "Claude subscription (pro)", provider: "anthropic", fetchedAt: 5, stale: false });
    expect(limits?.limits.map((l) => [l.id, l.label, l.percent, l.active])).toEqual([
      ["session", "Current session", 3, false],
      ["weekly_all", "This week", 63, true],
      ["weekly_scoped:Fable", "Fable this week", 0, false],
    ]);
  });

  it("has none for API-key logins or unexpected answers", () => {
    expect(claudeUsageLimits({ ...USAGE, rate_limits_available: false, rate_limits: null })).toBeNull();
    expect(claudeUsageLimits(null)).toBeNull();
    expect(claudeUsageLimits({ rate_limits_available: true, rate_limits: { limits: "?" } })).toBeNull();
  });

  it("reads them from a short-lived process without settings or MCP servers, then closes it", async () => {
    const sdk = new UsageSdk();
    const h = harness(sdk);
    expect(h.info.capabilities.usageLimits).toBe(true);
    expect(h.usageLimitsPolling.intervalMs).toBeGreaterThanOrEqual(60_000);
    const limits = await h.getUsageLimits();
    expect(limits?.limits[1]?.percent).toBe(63);
    expect(sdk.asked).toEqual([{ skipBehaviors: true }]);
    const q = sdk.queries[0]!;
    expect(q.options).toMatchObject({ persistSession: false, settingSources: [], strictMcpConfig: true, cwd: "/tmp/scratch" });
    expect(q.received).toEqual([]); // no prompt → no model call
    expect(q.closed).toBe(true);
  });

  it("is null when Claude Code isn't installed or the SDK has no usage call", async () => {
    const sdk = new UsageSdk();
    expect(await harness(sdk, false).getUsageLimits()).toBeNull();
    expect(sdk.queries).toHaveLength(0);
    const plain = new FakeClaudeSdk();
    expect(await harness(plain).getUsageLimits()).toBeNull();
    expect(plain.queries[0]?.closed).toBe(true);
  });
});
