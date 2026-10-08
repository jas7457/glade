import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../src/checks/scheduler.js";

vi.mock("../src/checks/http.js", () => ({
  runHttpCheck: vi.fn(),
}));
const { runHttpCheck } = await import("../src/checks/http.js");

const check = { id: "api", name: "API", url: "https://api.test", intervalSec: 30, timeoutMs: 1000 };

describe("Scheduler", () => {
  it("notifies once when a check goes down and once when it recovers", async () => {
    vi.useFakeTimers();
    const store = { record: vi.fn() };
    const notifier = { send: vi.fn().mockResolvedValue(undefined) };
    const results = [true, false, false, true].map((ok) => ({ checkId: "api", ok, status: ok ? 200 : 503, latencyMs: 40, at: 0 }));
    vi.mocked(runHttpCheck).mockImplementation(async () => results.shift()!);

    const scheduler = new Scheduler([check], store as any, notifier);
    scheduler.start();
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(30_000);
    scheduler.stop();

    expect(notifier.send.mock.calls.map(([a]) => a.kind)).toEqual(["down", "recovered"]);
  });
});
