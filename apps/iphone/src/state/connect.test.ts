import { beforeEach, describe, expect, it, vi } from "vitest";

const runPairing = vi.fn();
vi.mock("@/state/pairing", () => ({ runPairing: (...args: unknown[]) => runPairing(...args) }));
vi.mock("~/lib/secrets", () => ({ deviceId: async () => "iphone-test" }));

const { pairState, startPairing } = await import("./connect");

const link = (u: string) => `glade://pair?v=1&e=ENV1&n=Studio&u=${encodeURIComponent(u)}&g=grant123`;

describe("startPairing", () => {
  beforeEach(() => {
    runPairing.mockReset();
    runPairing.mockResolvedValue({ step: "cancelled" });
    pairState.value = null;
  });

  it("pairs as a phone with the iPhone's own device id", async () => {
    await startPairing(link("https://studio.tail.ts.net"));
    expect(runPairing).toHaveBeenCalledTimes(1);
    const [target, options] = runPairing.mock.calls[0]!;
    expect(target).toMatchObject({ environmentId: "ENV1", urls: ["https://studio.tail.ts.net"], grant: "grant123" });
    expect(options).toMatchObject({ deviceName: "iPhone", deviceKind: "phone", clientEnvironmentId: "iphone-test" });
  });

  it("refuses plain http to anything but loopback", async () => {
    const state = await startPairing(link("http://100.64.0.2:4317"));
    expect(state).toMatchObject({ step: "error" });
    expect(runPairing).not.toHaveBeenCalled();
    await startPairing(link("http://127.0.0.1:62398"));
    expect(runPairing).toHaveBeenCalledTimes(1);
  });

  it("reports input it can't read", async () => {
    const state = await startPairing("hello");
    expect(state.step).toBe("error");
    expect(pairState.value?.step).toBe("error");
  });
});
