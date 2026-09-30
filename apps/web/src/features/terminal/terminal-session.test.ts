/** Terminal tab connection (I-187): snapshot/replay, streaming, input/resize, exit + restart, "Session ended", reconnects. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_MISSING_CLOSE_CODE, type TerminalInfo, type TerminalServerMessage } from "@glade/protocol";
import { exitLine, TerminalSession, type TerminalScreen } from "./terminal-session";

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
  }
  receive(m: TerminalServerMessage) {
    this.onmessage?.({ data: JSON.stringify(m) } as MessageEvent);
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

function fakeScreen(): TerminalScreen & { text: string; resets: number } {
  return {
    cols: 100,
    rows: 30,
    text: "",
    resets: 0,
    write(data) {
      this.text += data;
    },
    reset() {
      this.text = "";
      this.resets++;
    },
  };
}

const info = (over: Partial<TerminalInfo> = {}): TerminalInfo => ({
  id: "t1",
  workspaceId: "w",
  cwd: "/repo",
  shell: "/bin/zsh",
  pid: 42,
  cols: 80,
  rows: 24,
  startedAt: 1,
  exit: null,
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

let session: TerminalSession | null = null;
beforeEach(() => {
  FakeSocket.all = [];
});
afterEach(() => {
  session?.dispose();
  session = null;
  vi.useRealTimers();
});

function make(start = vi.fn(async () => info())) {
  const screen = fakeScreen();
  const socketUrl = vi.fn(async () => "ws://host/ws/terminal/t1");
  session = new TerminalSession({ screen, socketUrl, start, WebSocketImpl: FakeSocket as unknown as new (url: string) => WebSocket, backoffMs: [10] });
  return { session, screen, socketUrl, start };
}

describe("TerminalSession", () => {
  it("replays the snapshot, streams output and sends input and its size", async () => {
    const { session, screen } = make();
    session.connect();
    await flush();
    const ws = FakeSocket.all[0]!;
    expect(ws.url).toBe("ws://host/ws/terminal/t1");
    ws.open();
    session.input("ignored before live");
    ws.receive({ type: "snapshot", data: "$ ls\r\nREADME.md\r\n", info: info() });
    expect(screen.text).toBe("$ ls\r\nREADME.md\r\n");
    expect(session.status.value).toBe("live");
    expect(ws.sent).toEqual([{ type: "resize", cols: 100, rows: 30 }]);
    ws.receive({ type: "output", data: "$ " });
    expect(screen.text.endsWith("$ ")).toBe(true);
    session.input("pwd\r");
    session.resize(120, 40);
    expect(ws.sent.slice(1)).toEqual([
      { type: "input", data: "pwd\r" },
      { type: "resize", cols: 120, rows: 40 },
    ]);
  });

  it("shows the exit line and restarts in place (the live socket gets `started`)", async () => {
    const { session, screen, start } = make();
    session.connect();
    await flush();
    const ws = FakeSocket.all[0]!;
    ws.open();
    ws.receive({ type: "snapshot", data: "", info: info() });
    ws.receive({ type: "exit", exit: { code: 130, signal: null } });
    expect(session.status.value).toBe("exited");
    expect(session.exit.value).toEqual({ code: 130, signal: null });
    expect(screen.text).toContain("[Process exited with code 130]");
    await session.restart();
    expect(start).toHaveBeenCalledWith({ cols: 100, rows: 30 });
    expect(FakeSocket.all).toHaveLength(1); // same socket
    ws.receive({ type: "started", info: info({ pid: 43 }) });
    expect(session.status.value).toBe("live");
    expect(session.exit.value).toBeNull();
  });

  it("a shell that exited before we attached shows as exited", async () => {
    const { session, screen } = make();
    session.connect();
    await flush();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ type: "snapshot", data: "done\r\n", info: info({ exit: { code: 0, signal: null } }) });
    expect(session.status.value).toBe("exited");
    expect(screen.text).toBe("done\r\n" + exitLine({ code: 0, signal: null }));
  });

  it("'Session ended' when the server has no such shell; New Session starts one and attaches", async () => {
    const { session, start } = make();
    session.connect();
    await flush();
    FakeSocket.all[0]!.drop(TERMINAL_MISSING_CLOSE_CODE);
    expect(session.status.value).toBe("ended");
    await session.restart();
    expect(start).toHaveBeenCalledOnce();
    await flush();
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.open();
    FakeSocket.all[1]!.receive({ type: "snapshot", data: "", info: info() });
    expect(session.status.value).toBe("live");
  });

  it("reconnects after a drop and replaces the screen with the new snapshot", async () => {
    const { session, screen } = make();
    session.connect();
    await flush();
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ type: "snapshot", data: "a\r\n", info: info() });
    FakeSocket.all[0]!.drop();
    expect(session.status.value).toBe("connecting");
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.open();
    FakeSocket.all[1]!.receive({ type: "snapshot", data: "a\r\nb\r\n", info: info() });
    expect(screen.text).toBe("a\r\nb\r\n");
    expect(screen.resets).toBe(2);
  });

  it("stops with an error when the host refuses the device, and on a failed restart", async () => {
    const socketUrl = vi.fn(async () => {
      throw Object.assign(new Error("This device isn't paired"), { status: 401 });
    });
    const screen = fakeScreen();
    session = new TerminalSession({ screen, socketUrl, start: vi.fn(async () => Promise.reject(new Error("nope"))), WebSocketImpl: FakeSocket as never, backoffMs: [10] });
    session.connect();
    await flush();
    expect(session.status.value).toBe("error");
    expect(session.error.value).toMatch(/paired/);
    await session.restart();
    expect(session.error.value).toBe("nope");
  });

  it("dispose closes the socket and stops reconnecting", async () => {
    const { session } = make();
    session.connect();
    await flush();
    const ws = FakeSocket.all[0]!;
    session.dispose();
    expect(ws.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(FakeSocket.all).toHaveLength(1);
  });
});
