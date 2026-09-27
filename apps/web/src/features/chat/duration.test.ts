import { describe, expect, it } from "vitest";
import type { ToolResult } from "@glade/protocol";
import { formatDuration, groupDuration, toolDuration } from "./duration";

const r = (over: Partial<ToolResult>): ToolResult => ({ toolCallId: "t", toolName: "bash", status: "done", output: "", ...over });

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(4_900)).toBe("4s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
    expect(formatDuration(-5)).toBe("0s");
  });
});

describe("toolDuration", () => {
  it("uses the stamps, live while running, null when unknown", () => {
    expect(toolDuration(r({ startedAt: 1_000, endedAt: 4_000 }), 99_000)).toBe(3_000);
    expect(toolDuration(r({ status: "running", startedAt: 1_000 }), 6_000)).toBe(5_000);
    expect(toolDuration(r({}), 6_000)).toBeNull();
    expect(toolDuration(undefined, 6_000)).toBeNull();
    expect(toolDuration(r({ startedAt: 1_000 }), 6_000)).toBeNull(); // done without an end stamp
  });
});

describe("groupDuration", () => {
  it("spans first start to last end", () => {
    expect(groupDuration([r({ startedAt: 1_000, endedAt: 3_000 }), r({ startedAt: 5_000, endedAt: 9_000 })], 50_000)).toBe(8_000);
  });

  it("runs to now while active, skipping calls without results", () => {
    const results = [r({ startedAt: 1_000, endedAt: 3_000 }), r({ status: "running", startedAt: 4_000 }), undefined];
    expect(groupDuration(results, 10_000, true)).toBe(9_000);
    expect(groupDuration([r({ startedAt: 1_000, endedAt: 3_000 }), undefined], 10_000, true)).toBe(9_000);
  });

  it("is null for unstamped history", () => {
    expect(groupDuration([r({}), r({})], 10_000)).toBeNull();
    expect(groupDuration([r({ startedAt: 1_000, endedAt: 2_000 }), r({})], 10_000)).toBeNull();
    expect(groupDuration([undefined], 10_000)).toBeNull();
  });
});
