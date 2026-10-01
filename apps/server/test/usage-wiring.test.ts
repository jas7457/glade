import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerMessage, UsageLimits } from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { AppService } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";

function limits(source: string, percent: number): UsageLimits {
  return {
    source,
    provider: "fake",
    fetchedAt: 1,
    stale: false,
    limits: [{ id: "session", label: "Current session", percent, resetsAt: null, severity: "normal", active: true }],
  };
}

const LIMITS = limits("Claude subscription", 44);

class LimitedHarness extends FakeHarness {
  calls = 0;
  constructor() {
    super(undefined, 0, {
      usageLimits: () => {
        this.calls++;
        return LIMITS;
      },
    });
  }
}

function setup(harnesses: FakeHarness[], options: { enabled?: (id: string) => boolean; preferred?: () => string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "glade-usage-"));
  const registry = new HarnessRegistry(harnesses, options);
  const service = new AppService({ store: new Store(join(dir, "data"), 0), harnesses: registry, scratchDir: join(dir, "scratch") });
  const messages: ServerMessage[] = [];
  const last = () => messages.filter((m) => m.type === "usage_limits").at(-1) as Extract<ServerMessage, { type: "usage_limits" }> | undefined;
  return {
    service,
    messages,
    last,
    dispose: async () => {
      await service.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("AppService usage limits wiring", () => {
  it("fetches once a client subscribes, broadcasts usage_limits and exposes the current value", async () => {
    const harness = new LimitedHarness();
    const t = setup([harness]);
    try {
      expect(t.service.getUsageLimits()).toEqual([]);
      t.service.subscribe((m) => t.messages.push(m));
      await expect.poll(() => t.last()).toBeTruthy();
      expect(harness.calls).toBe(1);
      expect(t.service.getUsageLimits()[0]?.usage.limits[0]?.percent).toBe(44);
      expect(t.last()?.usage?.limits[0]?.percent).toBe(44); // the default's, for older clients
      expect(t.last()?.entries?.map((e) => [e.harnessId, e.label])).toEqual([["fake", "Fake agent"]]);
    } finally {
      await t.dispose();
    }
  });

  it("stays inert for harnesses without usage limits", async () => {
    const t = setup([new FakeHarness()]);
    t.service.subscribe((m) => t.messages.push(m));
    expect(t.service.getUsageLimits()).toEqual([]);
    expect(t.service.usageLimitsMessage()).toBeNull();
    expect(t.messages.some((m) => m.type === "usage_limits")).toBe(false);
    await t.dispose();
  });

  it("I-191: lists every offered agent with limits, the default first, and skips agents that aren't offered", async () => {
    const a = new FakeHarness(undefined, 0, { id: "a", label: "Agent A", usageLimits: () => limits("Plan A", 10) });
    const b = new FakeHarness(undefined, 0, { id: "b", label: "Agent B", usageLimits: () => limits("Plan B", 20) });
    const none = new FakeHarness(undefined, 0, { id: "none", label: "No limits" });
    const cCalls: number[] = [];
    const c = new FakeHarness(undefined, 0, {
      id: "c",
      label: "Agent C",
      usageLimits: () => {
        cCalls.push(1);
        return limits("Plan C", 30);
      },
    });
    const t = setup([a, none, b, c], { preferred: () => "b", enabled: (id) => id !== "c" });
    try {
      t.service.subscribe((m) => t.messages.push(m));
      await expect.poll(() => t.service.getUsageLimits().length).toBe(2);
      const entries = t.service.getUsageLimits();
      expect(entries.map((e) => [e.harnessId, e.label, e.usage.source])).toEqual([
        ["b", "Agent B", "Plan B"],
        ["a", "Agent A", "Plan A"],
      ]);
      expect(cCalls).toEqual([]); // not offered → never read
      const message = t.service.usageLimitsMessage();
      expect(message?.type === "usage_limits" && message.usage?.source).toBe("Plan B");
    } finally {
      await t.dispose();
    }
  });
});
