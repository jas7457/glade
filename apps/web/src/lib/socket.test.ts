import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "./api";
import { CLOSE_UNAUTHORIZED, REMOTE_DISABLED_RETRY_MS, Socket } from "./socket";

describe("Socket.watch", () => {
  it("reports every watched session (counted) and drops released ones", () => {
    const socket = new Socket("ws://test");
    const send = vi.spyOn(socket, "send");
    const releaseA = socket.watch("a");
    const releaseB = socket.watch("b");
    const releaseA2 = socket.watch("a"); // same session in two views: no new message
    expect(send.mock.calls.map(([m]) => m)).toEqual([
      { type: "viewing", sessionIds: ["a"] },
      { type: "viewing", sessionIds: ["a", "b"] },
    ]);
    releaseA();
    releaseA(); // idempotent
    expect(send).toHaveBeenCalledTimes(2); // "a" is still shown by the other view
    releaseA2();
    releaseB();
    expect(send.mock.calls.slice(2).map(([m]) => m)).toEqual([
      { type: "viewing", sessionIds: ["b"] },
      { type: "viewing", sessionIds: [] },
    ]);
  });
});

describe("Socket auth (I-125)", () => {
  class FakeWs {
    static OPEN = 1;
    static instances: FakeWs[] = [];
    readyState = 0;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: ((e: { code: number }) => void) | null = null;
    constructor(readonly url: string) {
      FakeWs.instances.push(this);
    }
    send() {}
    close() {}
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    closeWith(code: number) {
      this.readyState = 3;
      this.onclose?.({ code });
    }
  }

  const setup = () => {
    FakeWs.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWs);
  };
  const teardown = () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  };

  it("gets a fresh ticket URL for every connect and reconnect", async () => {
    setup();
    try {
      let n = 0;
      const socket = new Socket(async () => `ws://h/ws?ticket=t${++n}`);
      socket.connect();
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeWs.instances.map((w) => w.url)).toEqual(["ws://h/ws?ticket=t1"]);
      FakeWs.instances[0]!.open();
      FakeWs.instances[0]!.closeWith(1006);
      await vi.advanceTimersByTimeAsync(300);
      expect(FakeWs.instances.map((w) => w.url)).toEqual(["ws://h/ws?ticket=t1", "ws://h/ws?ticket=t2"]);
      socket.disconnect();
    } finally {
      teardown();
    }
  });

  it("stops retrying when the token is refused (ticket 401 or close 4401)", async () => {
    setup();
    try {
      const errors: string[] = [];
      const refused = new Socket(async () => {
        throw new ApiRequestError(401, "unauthorized", "unauthorized");
      });
      refused.onAuthError((e) => errors.push(e));
      refused.connect();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(errors).toEqual(["unauthorized"]);
      expect(FakeWs.instances).toHaveLength(0);

      const revoked = new Socket(async () => "ws://h/ws?ticket=x");
      revoked.onAuthError((e) => errors.push(e));
      revoked.connect();
      await vi.advanceTimersByTimeAsync(0);
      FakeWs.instances[0]!.open();
      FakeWs.instances[0]!.closeWith(CLOSE_UNAUTHORIZED);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(errors).toEqual(["unauthorized", "unauthorized"]);
      expect(FakeWs.instances).toHaveLength(1);
    } finally {
      teardown();
    }
  });

  it("retries slowly while remote access is off (403 remote_disabled)", async () => {
    setup();
    try {
      let calls = 0;
      const errors: string[] = [];
      const socket = new Socket(async () => {
        calls++;
        throw new ApiRequestError(403, "off", "remote_disabled");
      });
      socket.onAuthError((e) => errors.push(e));
      socket.connect();
      await vi.advanceTimersByTimeAsync(REMOTE_DISABLED_RETRY_MS - 1000);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      expect(errors).toEqual(["remote_disabled", "remote_disabled"]);
      socket.disconnect();
    } finally {
      teardown();
    }
  });
});
