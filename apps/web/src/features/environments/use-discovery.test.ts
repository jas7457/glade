/** I-137: tailnet discovery refreshes while shown (timer, focus, visibility), never overlapping. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredEnvironment } from "@glade/protocol";
import { DISCOVERY_POLL_MS, startDiscoveryPoller } from "./use-discovery";

const host = (name: string, reachable = true): DiscoveredEnvironment => ({ name, address: `https://${name}.ts.net`, reachable });

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A discover() whose answers the test resolves by hand. */
function manual() {
  const pending: Array<(list: DiscoveredEnvironment[]) => void> = [];
  const discover = vi.fn(() => new Promise<DiscoveredEnvironment[]>((resolve) => pending.push(resolve)));
  return { discover, answer: async (list: DiscoveredEnvironment[]) => (pending.shift()!(list), await vi.advanceTimersByTimeAsync(0)) };
}

describe("startDiscoveryPoller", () => {
  it("asks at once, then every 10 s; only reachable hosts come through", async () => {
    const { discover, answer } = manual();
    const onResult = vi.fn();
    const p = startDiscoveryPoller({ discover, onResult });
    await vi.advanceTimersByTimeAsync(0);
    expect(discover).toHaveBeenCalledTimes(1);
    await answer([host("air"), host("phone", false)]);
    expect(onResult).toHaveBeenLastCalledWith([host("air")]);
    await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS);
    expect(discover).toHaveBeenCalledTimes(2);
    await answer([host("air"), host("pro")]);
    expect(onResult).toHaveBeenLastCalledWith([host("air"), host("pro")]);
    p.stop();
  });

  it("refreshes on window focus and when the window becomes visible; not while hidden", async () => {
    const { discover, answer } = manual();
    const p = startDiscoveryPoller({ discover, onResult: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    await answer([]);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(discover).toHaveBeenCalledTimes(2);
    await answer([]);

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS * 3);
    expect(discover).toHaveBeenCalledTimes(2);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(discover).toHaveBeenCalledTimes(3);
    p.stop();
  });

  it("never runs two requests at once: a refresh joins the running one", async () => {
    const { discover, answer } = manual();
    const p = startDiscoveryPoller({ discover, onResult: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    const joined = p.refresh();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS);
    expect(discover).toHaveBeenCalledTimes(1);
    await answer([]);
    await joined;
    void p.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(discover).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it("stops: no timer, no focus refresh, a late answer is dropped", async () => {
    const { discover, answer } = manual();
    const onResult = vi.fn();
    const p = startDiscoveryPoller({ discover, onResult });
    await vi.advanceTimersByTimeAsync(0);
    p.stop();
    await answer([host("air")]);
    expect(onResult).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS * 3);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("a failed request keeps the last list and doesn't stop polling", async () => {
    const discover = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue([host("air")]);
    const onResult = vi.fn();
    const p = startDiscoveryPoller({ discover, onResult });
    await vi.advanceTimersByTimeAsync(0);
    expect(onResult).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DISCOVERY_POLL_MS);
    expect(onResult).toHaveBeenCalledWith([host("air")]);
    p.stop();
  });
});
