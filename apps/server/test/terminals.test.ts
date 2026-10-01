/**
 * I-187: terminal tabs. The service with a fake pty (spawn, stream, input, resize, scrollback,
 * exit/restart, kill, backpressure), the HTTP + WebSocket routes (local owner, paired devices
 * with a ticket, revocation, workspace deletion), and one real node-pty shell.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { TERMINAL_MISSING_CLOSE_CODE, type PairingInvite, type PairResponse, type TerminalInfo, type TerminalServerMessage } from "@glade/protocol";
import { createApp } from "../src/http/app.js";
import { AuthService, CLOSE_REVOKED } from "../src/services/auth/auth-service.js";
import { foregroundCommandLine, HIGH_WATER, isShellName, TerminalService, type Pty, type PtySpawnOptions, type SpawnPty } from "../src/services/terminals.js";
import { createTestEnv, newChat, until, type TestEnv } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

class FakePty implements Pty {
  static nextPid = 1000;
  readonly pid = FakePty.nextPid++;
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed: string[] = [];
  paused = false;
  /** node-pty's foreground process name. */
  process = "zsh";
  private dataListeners = new Set<(d: string) => void>();
  private exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly options: PtySpawnOptions,
  ) {}
  onData(l: (d: string) => void) {
    this.dataListeners.add(l);
    return { dispose: () => this.dataListeners.delete(l) };
  }
  onExit(l: (e: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.add(l);
    return { dispose: () => this.exitListeners.delete(l) };
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.sizes.push([c, r]);
  }
  kill(signal?: string) {
    this.killed.push(signal ?? "SIGHUP");
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  emit(d: string) {
    for (const l of this.dataListeners) l(d);
  }
  exit(code: number) {
    for (const l of this.exitListeners) l({ exitCode: code, signal: 0 });
  }
}

function fakeSpawner() {
  const ptys: FakePty[] = [];
  const spawn: SpawnPty = (file, args, options) => {
    const p = new FakePty(file, args, options);
    ptys.push(p);
    return p;
  };
  return { ptys, spawn };
}

function recorder(buffered = () => 0) {
  const messages: TerminalServerMessage[] = [];
  return {
    messages,
    client: { send: (m: TerminalServerMessage) => messages.push(m), bufferedAmount: buffered },
    output: () =>
      messages
        .filter((m) => m.type === "output" || m.type === "snapshot")
        .map((m) => (m as { data: string }).data)
        .join(""),
  };
}

describe("TerminalService", () => {
  const folders: Record<string, string> = { w1: tmpdir(), gone: "/definitely/not/here" };
  const make = (opts: Partial<ConstructorParameters<typeof TerminalService>[0]> = {}) => {
    const f = fakeSpawner();
    const service = new TerminalService({
      cwdOf: (id) => folders[id] ?? null,
      spawn: f.spawn,
      shell: "/bin/zsh",
      env: { PATH: "/usr/bin", GLADE_TOKEN: "secret", GLADE_DATA_DIR: "/data", npm_config_x: "1", HOME: "/Users/me" },
      flushMs: 1,
      ...opts,
    });
    cleanups.push(() => service.dispose());
    return { service, ...f };
  };

  it("spawns a login shell in the workspace folder with a clean terminal environment", async () => {
    const { service, ptys } = make();
    const info = await service.start("w1", "t1", { cols: 100, rows: 30 });
    expect(info).toMatchObject({ id: "t1", workspaceId: "w1", cwd: tmpdir(), shell: "/bin/zsh", cols: 100, rows: 30, exit: null });
    const pty = ptys[0]!;
    expect(pty.file).toBe("/bin/zsh");
    expect(pty.args).toEqual(["-l"]);
    expect(pty.options.cwd).toBe(tmpdir());
    expect(pty.options.env).toMatchObject({ TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Glade", LANG: "en_US.UTF-8", PATH: "/usr/bin", GLADE_DATA_DIR: "/data" });
    expect(pty.options.env.GLADE_TOKEN).toBeUndefined();
    expect(pty.options.env.npm_config_x).toBeUndefined();
    // Idempotent while running.
    expect((await service.start("w1", "t1", { cols: 80, rows: 24 })).pid).toBe(info.pid);
    expect(ptys).toHaveLength(1);
    // Sizes are clamped.
    expect((await service.start("w1", "t2", { cols: 0, rows: 99999 })).rows).toBe(500);
  });

  it("refuses unknown workspaces and falls back to home for a missing folder", async () => {
    const { service } = make();
    await expect(service.start("nope", "t1", { cols: 80, rows: 24 })).rejects.toMatchObject({ status: 404 });
    expect((await service.start("gone", "t2", { cols: 80, rows: 24 })).cwd).toBe(homedir());
    await expect(service.start("w1", "t2", { cols: 80, rows: 24 })).rejects.toMatchObject({ status: 400 });
  });

  it("streams output in batches, forwards input and resizes, and replays scrollback on attach", async () => {
    const { service, ptys } = make();
    await service.start("w1", "t1", { cols: 80, rows: 24 });
    const pty = ptys[0]!;
    pty.emit("before attach\r\n");
    const a = recorder();
    const att = service.attach("t1", a.client)!;
    expect(a.messages[0]).toMatchObject({ type: "snapshot", data: "before attach\r\n", info: { id: "t1" } });
    pty.emit("one ");
    pty.emit("two\r\n");
    await until(() => a.messages.length === 2);
    expect(a.messages[1]).toEqual({ type: "output", data: "one two\r\n" });
    att.input("ls\r");
    expect(pty.written).toEqual(["ls\r"]);
    att.resize(120, 40);
    att.resize(120, 40); // unchanged: not forwarded again
    expect(pty.sizes).toEqual([[120, 40]]);
    expect(service.get("t1")).toMatchObject({ cols: 120, rows: 40 });
    // A second client (another window / a reload) gets everything so far.
    const b = recorder();
    service.attach("t1", b.client);
    expect(b.output()).toBe("before attach\r\none two\r\n");
    att.detach();
    pty.emit("more");
    await until(() => b.messages.length === 2);
    expect(a.messages).toHaveLength(2);
    expect(service.attach("nope", recorder().client)).toBeNull();
  });

  it("keeps only the newest scrollback, cut at a line break", async () => {
    const { service, ptys } = make({ scrollbackChars: 100 });
    await service.start("w1", "t1", { cols: 80, rows: 24 });
    for (let i = 0; i < 50; i++) ptys[0]!.emit(`line ${i}\r\n`);
    const a = recorder();
    service.attach("t1", a.client);
    const snap = a.output();
    expect(snap.length).toBeLessThanOrEqual(100);
    expect(snap.startsWith("line ")).toBe(true);
    expect(snap.endsWith("line 49\r\n")).toBe(true);
  });

  it("reports exits and restarts under the same id, keeping the scrollback", async () => {
    const { service, ptys } = make();
    await service.start("w1", "t1", { cols: 80, rows: 24 });
    const a = recorder();
    const att = service.attach("t1", a.client)!;
    ptys[0]!.emit("bye\r\n");
    ptys[0]!.exit(3);
    expect(a.messages.at(-1)).toEqual({ type: "exit", exit: { code: 3, signal: null } });
    expect(service.get("t1")?.exit).toEqual({ code: 3, signal: null });
    att.input("ignored");
    expect(ptys[0]!.written).toEqual([]);
    const again = await service.start("w1", "t1", { cols: 80, rows: 24 });
    expect(again.exit).toBeNull();
    expect(ptys).toHaveLength(2);
    expect(a.messages.at(-1)).toMatchObject({ type: "started", info: { pid: ptys[1]!.pid } });
    const b = recorder();
    service.attach("t1", b.client);
    expect(b.output()).toBe("bye\r\n");
  });

  it("closing a tab SIGHUPs its shell; deleting a workspace closes its shells", async () => {
    const { service, ptys } = make();
    await service.start("w1", "t1", { cols: 80, rows: 24 });
    await service.start("w1", "t2", { cols: 80, rows: 24 });
    expect(service.kill("t1")).toBe(true);
    expect(ptys[0]!.killed).toEqual(["SIGHUP"]);
    expect(service.get("t1")).toBeNull();
    expect(service.kill("t1")).toBe(false);
    service.killWorkspace("w1");
    expect(ptys[1]!.killed).toEqual(["SIGHUP"]);
    expect(service.list("w1")).toEqual([]);
  });

  it("tells what runs in the foreground (I-192): the command line, else node-pty's process name", async () => {
    let command: string | null | undefined = undefined;
    const { service, ptys } = make({ foregroundCommand: async () => command });
    await service.start("w1", "t1", { cols: 80, rows: 24 });
    const pty = ptys[0]!;
    expect(await service.foreground("t1")).toBeNull(); // "zsh": at the prompt
    pty.process = "node";
    expect(await service.foreground("t1")).toBe("node");
    command = "npm   run dev";
    expect(await service.foreground("t1")).toBe("npm run dev");
    expect(await service.listWithForeground("w1")).toMatchObject([{ id: "t1", foreground: "npm run dev" }]);
    command = null; // ps: the shell's own group is in the foreground
    expect(await service.foreground("t1")).toBeNull();
    command = "x".repeat(300);
    expect((await service.foreground("t1"))?.length).toBe(200);
    command = "sleep 100";
    pty.exit(0);
    expect(await service.foreground("t1")).toBeNull(); // exited
    expect(await service.foreground("nope")).toBeNull();
  });

  it("counts shells, tmux and screen as idle", () => {
    expect(isShellName("zsh", "/bin/zsh")).toBe(true);
    expect(isShellName("-zsh", "/bin/zsh")).toBe(true);
    expect(isShellName("/bin/bash", "/bin/zsh")).toBe(true);
    expect(isShellName("/opt/homebrew/bin/tmux", "")).toBe(true);
    expect(isShellName("myshell", "/usr/local/bin/myshell")).toBe(true);
    expect(isShellName("node", "/bin/zsh")).toBe(false);
    expect(isShellName("vim", "/bin/zsh")).toBe(false);
  });

  it("pauses the shell while a client is far behind", async () => {
    let buffered = 0;
    const { service, ptys } = make();
    await service.start("w1", "t1", { cols: 80, rows: 24 });
    service.attach("t1", recorder(() => buffered).client);
    buffered = HIGH_WATER + 1;
    ptys[0]!.emit("x");
    await until(() => ptys[0]!.paused);
    buffered = 0;
    await until(() => !ptys[0]!.paused);
  });
});

describe("terminal routes", () => {
  const HOST = "127.0.0.1:4317";
  const OTHER = "http://127.0.0.1:4400";

  async function setup() {
    const env: TestEnv = createTestEnv();
    const f = fakeSpawner();
    const terminals = new TerminalService({
      cwdOf: (id) => env.store.getWorkspace(id)?.cwd ?? null,
      spawn: f.spawn,
      shell: "/bin/zsh",
      flushMs: 1,
      foregroundCommand: async () => undefined,
    });
    const auth = new AuthService({
      db: env.store.db,
      environmentId: env.service.environment.id,
      environmentName: () => "Test Host",
      addresses: () => ["http://127.0.0.1:4317"],
      watchMs: 0,
      pairTimeoutMs: 5000,
      pairPollMs: 5,
    });
    const { app, injectWebSocket } = createApp({ service: env.service, auth, terminals, ownPorts: () => [4317, 5317] });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    injectWebSocket(server);
    await new Promise<void>((r) => server.once("listening", () => r()));
    cleanups.push(async () => {
      server.close();
      terminals.dispose();
      auth.dispose();
      await env.cleanup();
    });
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, o: { body?: unknown; token?: string; origin?: string } = {}) =>
      app.request(
        path,
        {
          method,
          headers: {
            host: HOST,
            ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
            ...(o.origin ? { origin: o.origin } : {}),
          },
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
        },
        { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
      );
    const pairDevice = async () => {
      await call("PATCH", "/api/auth/remote", { body: { enabled: true } });
      const inv = (await (await call("POST", "/api/auth/invites")).json()) as PairingInvite;
      const grant = new URL(inv.link.replace("glade://", "http://x/")).searchParams.get("g")!;
      const res = call("POST", "/api/auth/pair", { body: { grant, deviceName: "Laptop", deviceKind: "mac" }, origin: OTHER });
      for (let i = 0; i < 400; i++) {
        const list = (await (await call("GET", "/api/auth/pending")).json()) as { id: string }[];
        if (list.length) {
          await call("POST", `/api/auth/pending/${list[0]!.id}`, { body: { allow: true } });
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      return (await (await res).json()) as Extract<PairResponse, { status: "paired" }>;
    };
    return { env, terminals, ptys: f.ptys, port, call, pairDevice };
  }

  const connect = (url: string, origin: string) => {
    const ws = new WebSocket(url, { origin });
    const received: TerminalServerMessage[] = [];
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    ws.on("message", (d) => received.push(JSON.parse(String(d)) as TerminalServerMessage));
    const status = new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => resolve(101));
      ws.once("error", () => resolve(-1));
    });
    return { ws, received, closed, status };
  };

  it("starts a shell, streams it over the socket, and closes it with the tab", async () => {
    const t = await setup();
    const { wid } = await newChat(t.env);
    const res = await t.call("POST", `/api/workspaces/${wid}/terminals/tab1/start`, { body: { cols: 90, rows: 20 } });
    expect(res.status).toBe(200);
    const info = (await res.json()) as TerminalInfo;
    expect(info).toMatchObject({ id: "tab1", workspaceId: wid, cols: 90, rows: 20 });
    const list = async () => (await (await t.call("GET", `/api/workspaces/${wid}/terminals`)).json()) as TerminalInfo[];
    expect(await list()).toMatchObject([{ id: "tab1", foreground: null }]);
    t.ptys[0]!.process = "sleep"; // I-192: the tab asks before closing a busy shell
    expect(await list()).toMatchObject([{ id: "tab1", foreground: "sleep" }]);
    t.ptys[0]!.emit("hello\r\n");

    const s = connect(`ws://127.0.0.1:${t.port}/ws/terminal/tab1`, "http://127.0.0.1:5317");
    expect(await s.status).toBe(101);
    await until(() => s.received.length > 0);
    expect(s.received[0]).toMatchObject({ type: "snapshot", data: "hello\r\n" });
    s.ws.send(JSON.stringify({ type: "input", data: "pwd\r" }));
    s.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await until(() => t.ptys[0]!.written.length > 0 && t.ptys[0]!.sizes.length > 0);
    expect(t.ptys[0]!.written).toEqual(["pwd\r"]);
    expect(t.ptys[0]!.sizes).toEqual([[100, 30]]);
    t.ptys[0]!.emit("/tmp\r\n");
    await until(() => s.received.some((m) => m.type === "output"));

    expect((await t.call("DELETE", "/api/terminals/tab1")).status).toBe(204);
    expect(t.ptys[0]!.killed).toEqual(["SIGHUP"]);
    // Gone: a new socket is closed with 4404 (the tab shows "Session ended").
    const gone = connect(`ws://127.0.0.1:${t.port}/ws/terminal/tab1`, "http://127.0.0.1:5317");
    expect(await gone.closed).toBe(TERMINAL_MISSING_CLOSE_CODE);
    s.ws.close();
  });

  it("validates ids and workspaces", async () => {
    const t = await setup();
    const { wid } = await newChat(t.env);
    expect((await t.call("POST", `/api/workspaces/${wid}/terminals/bad%20id/start`, { body: {} })).status).toBe(400);
    expect((await t.call("POST", `/api/workspaces/nope/terminals/t1/start`, { body: {} })).status).toBe(404);
  });

  it("deleting the workspace closes its shells", async () => {
    const t = await setup();
    const { wid } = await newChat(t.env);
    await t.call("POST", `/api/workspaces/${wid}/terminals/t1/start`, { body: { cols: 80, rows: 24 } });
    await t.env.service.deleteWorkspace(wid);
    await until(() => t.ptys[0]!.killed.length > 0);
    expect(t.terminals.list(wid)).toEqual([]);
  });

  it("paired devices need a token (REST) or a one-time ticket (socket); revoking closes their terminal", async () => {
    const t = await setup();
    const { wid } = await newChat(t.env);
    // Remote access off: refused.
    expect((await t.call("POST", `/api/workspaces/${wid}/terminals/t1/start`, { body: {}, origin: OTHER })).status).toBe(403);
    const { token, device } = await t.pairDevice();
    expect((await t.call("POST", `/api/workspaces/${wid}/terminals/t1/start`, { body: {}, origin: OTHER })).status).toBe(401);
    expect((await t.call("POST", `/api/workspaces/${wid}/terminals/t1/start`, { body: {}, origin: OTHER, token })).status).toBe(200);
    const url = `ws://127.0.0.1:${t.port}/ws/terminal/t1`;
    expect(await connect(url, OTHER).status).toBe(401);
    expect(await connect(`${url}?ticket=nope`, OTHER).status).toBe(401);
    const { ticket } = (await (await t.call("POST", "/api/auth/ws-ticket", { origin: OTHER, token })).json()) as { ticket: string };
    const s = connect(`${url}?ticket=${ticket}`, OTHER);
    expect(await s.status).toBe(101);
    await until(() => s.received.length > 0);
    expect(await connect(`${url}?ticket=${ticket}`, OTHER).status).toBe(401); // single use
    await t.call("DELETE", `/api/auth/devices/${device.id}`);
    expect(await s.closed).toBe(CLOSE_REVOKED);
  });
});

describe("node-pty (real shell)", () => {
  it.skipIf(process.platform === "win32")("runs a login shell in the folder and ends on SIGHUP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-term-"));
    const service = new TerminalService({ cwdOf: () => dir, shell: "/bin/sh", flushMs: 1 });
    cleanups.push(() => {
      service.dispose();
      rmSync(dir, { recursive: true, force: true });
    });
    const info = await service.start("w", "real", { cols: 80, rows: 24 });
    const r = recorder();
    const att = service.attach("real", r.client)!;
    att.input("echo \"cwd=$(pwd) term=$TERM\"\r");
    await until(() => /cwd=.*glade-term-.* term=xterm-256color/.test(r.output()), 5000);
    att.input("exit 7\r");
    await until(() => r.messages.some((m) => m.type === "exit"), 5000);
    expect(r.messages.find((m) => m.type === "exit")).toMatchObject({ exit: { code: 7 } });
    expect(info.pid).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === "win32")("knows what the shell runs in the foreground (ps)", async () => {
    const eventually = async (check: () => Promise<boolean>) => {
      for (const start = Date.now(); !(await check()); await new Promise((r) => setTimeout(r, 50))) {
        if (Date.now() - start > 5000) throw new Error("condition not met in time");
      }
    };
    const service = new TerminalService({ cwdOf: () => tmpdir(), shell: "/bin/sh", flushMs: 1 });
    cleanups.push(() => service.dispose());
    const info = await service.start("w", "fg", { cols: 80, rows: 24 });
    const att = service.attach("fg", recorder().client)!;
    att.input("echo ready\r");
    await eventually(async () => (await foregroundCommandLine(info.pid)) === null);
    expect(await service.foreground("fg")).toBeNull();
    att.input("sleep 30\r");
    await eventually(async () => (await service.foreground("fg")) === "sleep 30");
    att.input("\x03");
    await eventually(async () => (await service.foreground("fg")) === null);
  });
});
