import { beforeEach, describe, expect, it, vi } from "vitest";

const runPairing = vi.fn();
vi.mock("@glade/app-core/state/pairing", () => ({ runPairing: (...args: unknown[]) => runPairing(...args) }));
vi.mock("~/lib/secrets", () => ({ deviceId: async () => "iphone-test" }));

const { cleanPhoneName, pairState, phoneName, setPhoneName, startPairing, syncPhoneName } = await import("./connect");
const { connections } = await import("@glade/app-core/state/env-registry");
const { fakeEnv } = await import("~/test/fake-env");

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

describe("this iPhone's name (I-171)", () => {
  beforeEach(() => {
    localStorage.clear();
    runPairing.mockReset();
    phoneName.value = "iPhone";
    connections.value = [];
  });

  it("cleans names: trims, collapses whitespace, caps, empty → iPhone", () => {
    expect(cleanPhoneName("  Jason's \n iPhone ")).toBe("Jason's iPhone");
    expect(cleanPhoneName("   ")).toBe("iPhone");
    expect(cleanPhoneName("x".repeat(150))).toHaveLength(100);
    expect(setPhoneName(" Work  Phone ")).toBe("Work Phone");
    expect(localStorage.getItem("glade.iphone.deviceName")).toBe("Work Phone");
  });

  it("pairs with the saved name", async () => {
    setPhoneName("Jason's iPhone");
    runPairing.mockResolvedValue({ step: "paired", environment: { id: "ENV1", name: "Studio", urls: [] } });
    await startPairing(link("https://studio.tail.ts.net"));
    expect(runPairing.mock.calls[0]![1]).toMatchObject({ deviceName: "Jason's iPhone" });
    // The Mac already has it: nothing to push when it connects.
    const studio = fakeEnv("ENV1", "Studio");
    const request = vi.fn(async () => ({}));
    (studio as { request: unknown }).request = request;
    connections.value = [studio];
    const stop = syncPhoneName();
    stop();
    expect(request).not.toHaveBeenCalled();
  });

  it("renames itself on every connected Mac, and on the others once they connect", async () => {
    const a = fakeEnv("A", "Studio");
    const b = fakeEnv("B", "Air", "offline");
    const reqA = vi.fn(async () => ({}));
    const reqB = vi.fn(async () => ({}));
    (a as { request: unknown }).request = reqA;
    (b as { request: unknown }).request = reqB;
    connections.value = [a, b];
    const stop = syncPhoneName();
    await vi.waitFor(() => expect(reqA).toHaveBeenCalledWith("PATCH", "/auth/me", { name: "iPhone" }));
    setPhoneName("Pocket");
    await vi.waitFor(() => expect(reqA).toHaveBeenLastCalledWith("PATCH", "/auth/me", { name: "Pocket" }));
    expect(reqB).not.toHaveBeenCalled();
    b.status.value = "live";
    await vi.waitFor(() => expect(reqB).toHaveBeenCalledWith("PATCH", "/auth/me", { name: "Pocket" }));
    // Already synced: a reconnect doesn't push again.
    const calls = reqA.mock.calls.length;
    a.status.value = "offline";
    a.status.value = "live";
    await new Promise((r) => setTimeout(r, 0));
    expect(reqA.mock.calls.length).toBe(calls);
    stop();
  });

  it("tries a failed push again when that Mac reconnects", async () => {
    const a = fakeEnv("A", "Studio");
    const req = vi.fn().mockRejectedValueOnce(new Error("404")).mockResolvedValue({});
    (a as { request: unknown }).request = req;
    connections.value = [a];
    const stop = syncPhoneName();
    await vi.waitFor(() => expect(req).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    a.status.value = "offline";
    a.status.value = "live";
    await vi.waitFor(() => expect(req).toHaveBeenCalledTimes(2));
    stop();
  });
});
