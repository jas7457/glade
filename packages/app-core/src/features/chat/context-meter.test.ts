import { describe, expect, it } from "vitest";
import { describeStats, describeUsage, formatCost, formatTokens, meterLevel, usagePercent } from "./context-meter";

describe("context meter helpers", () => {
  it("formats token counts", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(42_130)).toBe("42.1k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_048_576)).toBe("1M");
  });

  it("formats cost, hiding zero", () => {
    expect(formatCost(0)).toBeNull();
    expect(formatCost(undefined)).toBeNull();
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.454)).toBe("$0.45");
    expect(formatCost(12.3)).toBe("$12.30");
  });

  it("uses pi's percent, falls back to tokens / window, null when unknown", () => {
    expect(usagePercent({ tokens: 42_100, contextWindow: 200_000, percent: 21.05 })).toBe(21.05);
    expect(usagePercent({ tokens: 50_000, contextWindow: 200_000, percent: null })).toBe(25);
    expect(usagePercent({ tokens: null, contextWindow: 200_000, percent: null })).toBeNull();
  });

  it("thresholds: amber above 80%, red above 95%", () => {
    expect(meterLevel(null)).toBe("normal");
    expect(meterLevel(80)).toBe("normal");
    expect(meterLevel(80.1)).toBe("warning");
    expect(meterLevel(95)).toBe("warning");
    expect(meterLevel(95.5)).toBe("critical");
  });

  it("describes usage", () => {
    expect(describeUsage({ tokens: 42_100, contextWindow: 200_000, percent: 21.05 })).toBe("42.1k / 200k tokens (21%)");
    expect(describeUsage({ tokens: 900, contextWindow: 200_000, percent: 0.45 })).toBe("900 / 200k tokens (<1%)");
    expect(describeUsage({ tokens: null, contextWindow: 200_000, percent: null })).toBe("? / 200k tokens");
  });

  it("describes /stats", () => {
    expect(describeStats({})).toBe("No usage yet");
    expect(
      describeStats({
        contextUsage: { tokens: 60_000, contextWindow: 200_000, percent: 30 },
        sessionStats: { tokens: { input: 50_000, output: 10_000, cacheRead: 40_000, cacheWrite: 5_000, total: 105_000 }, cost: 0.45 },
      }),
    ).toBe("Context 60k / 200k tokens (30%) · Session 105k tokens (50k in, 10k out, 45k cache) · $0.45");
  });
});
