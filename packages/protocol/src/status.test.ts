import { describe, expect, it } from "vitest";
import { aggregateChatStatus, deriveChatStatus, needsAttention } from "./status.js";

describe("deriveChatStatus", () => {
  it("applies precedence blocked > working > unread > idle", () => {
    expect(deriveChatStatus({ running: true, pendingInputs: 1, unread: true })).toBe("blocked");
    expect(deriveChatStatus({ running: true, pendingInputs: 0, unread: true })).toBe("working");
    expect(deriveChatStatus({ running: false, pendingInputs: 0, unread: true })).toBe("unread");
    expect(deriveChatStatus({ running: false, pendingInputs: 0, unread: false })).toBe("idle");
  });
});

describe("aggregateChatStatus", () => {
  it("returns the most urgent status", () => {
    expect(aggregateChatStatus([])).toBe("idle");
    expect(aggregateChatStatus(["idle", "unread", "working"])).toBe("working");
    expect(aggregateChatStatus(["unread", "blocked", "idle"])).toBe("blocked");
  });
  it("flags attention states", () => {
    expect(needsAttention("unread")).toBe(true);
    expect(needsAttention("blocked")).toBe(true);
    expect(needsAttention("working")).toBe(false);
  });
});
