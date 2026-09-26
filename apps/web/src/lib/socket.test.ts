import { describe, expect, it, vi } from "vitest";
import { Socket } from "./socket";

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
