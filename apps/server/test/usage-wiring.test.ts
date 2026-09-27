import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerMessage, UsageLimits } from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { AppService } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";

const LIMITS: UsageLimits = {
  source: "Claude subscription",
  provider: "anthropic",
  fetchedAt: 1,
  stale: false,
  limits: [{ id: "session", label: "Current session", percent: 44, resetsAt: null, severity: "normal", active: true }],
};

class LimitedHarness extends FakeHarness {
  calls = 0;
  async getUsageLimits(): Promise<UsageLimits | null> {
    this.calls++;
    return LIMITS;
  }
}

describe("AppService usage limits wiring", () => {
  it("fetches once a client subscribes, broadcasts usage_limits and exposes the current value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-usage-"));
    const harness = new LimitedHarness();
    const service = new AppService({ store: new Store(join(dir, "data"), 0), harnesses: new HarnessRegistry([harness]), scratchDir: join(dir, "scratch") });
    try {
      expect(service.getUsageLimits()).toBeNull();
      const messages: ServerMessage[] = [];
      service.subscribe((m) => messages.push(m));
      await expect.poll(() => messages.find((m) => m.type === "usage_limits")).toBeTruthy();
      expect(harness.calls).toBe(1);
      expect(service.getUsageLimits()?.limits[0]?.percent).toBe(44);
    } finally {
      await service.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays inert for harnesses without usage limits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-usage-"));
    const service = new AppService({ store: new Store(join(dir, "data"), 0), harnesses: new HarnessRegistry([new FakeHarness()]), scratchDir: join(dir, "scratch") });
    const messages: ServerMessage[] = [];
    service.subscribe((m) => messages.push(m));
    expect(service.getUsageLimits()).toBeNull();
    expect(messages.some((m) => m.type === "usage_limits")).toBe(false);
    await service.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
});
