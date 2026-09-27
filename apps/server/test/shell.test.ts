/**
 * `!cmd` / `!!cmd` (I-076): the pi translator (history + live), PiSession's RPC `bash`, and the
 * server endpoints against FakeHarness.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ShellMessage } from "@glade/protocol";
import { createApp } from "../src/http/app.js";
import { PiSession } from "../src/harness/pi/pi-harness.js";
import type { PiRpcProcess } from "../src/harness/pi/rpc-process.js";
import { PiEventTranslator, translateMessages } from "../src/harness/pi/translate.js";
import { createTestEnv, flush, until, type TestEnv } from "./helpers.js";

describe("pi translator: user shell commands", () => {
  it("maps history bashExecution to shell messages (shared unless excludeFromContext)", () => {
    const t = translateMessages(
      [
        { role: "bashExecution", command: "ls", output: "a.txt\n", exitCode: 0, cancelled: false, truncated: false, fullOutputPath: null, timestamp: 5 },
        { role: "bashExecution", command: "echo secret", output: "secret\n", exitCode: 0, cancelled: false, truncated: false, timestamp: 6, excludeFromContext: true },
        { role: "bashExecution", command: "sleep 30", output: "", exitCode: undefined, cancelled: true, truncated: true, fullOutputPath: "/tmp/pi-bash.log", timestamp: 7 },
      ],
      (i) => `h${i}`,
    );
    expect(t.messages).toEqual<ShellMessage[]>([
      { id: "h0", role: "shell", command: "ls", shared: true, running: false, output: "a.txt\n", exitCode: 0, cancelled: false, truncated: false, timestamp: 5 },
      { id: "h1", role: "shell", command: "echo secret", shared: false, running: false, output: "secret\n", exitCode: 0, cancelled: false, truncated: false, timestamp: 6 },
      {
        id: "h2",
        role: "shell",
        command: "sleep 30",
        shared: true,
        running: false,
        output: "",
        exitCode: null,
        cancelled: true,
        truncated: true,
        fullOutputPath: "/tmp/pi-bash.log",
        timestamp: 7,
      },
    ]);
  });

  it("maps bash_execution_update to shell_update", () => {
    const t = new PiEventTranslator();
    expect(t.translate({ type: "bash_execution_update", id: "shell-1", delta: "a.txt\n" })).toEqual([{ type: "shell_update", id: "shell-1", delta: "a.txt\n" }]);
    expect(t.translate({ type: "bash_execution_update", delta: "no id" })).toEqual([]);
    expect(t.translate({ type: "bash_execution_update", id: "shell-1", delta: "" })).toEqual([]);
  });
});

class StubProc extends EventEmitter {
  readonly calls: Array<{ command: Record<string, unknown>; timeoutMs?: number }> = [];
  readonly waiting: Array<{ type: string; resolve: (d: unknown) => void; reject: (e: Error) => void }> = [];
  request(command: Record<string, unknown> & { type: string }, timeoutMs?: number): Promise<unknown> {
    this.calls.push({ command, timeoutMs });
    if (command.type === "abort_bash") return Promise.resolve(undefined);
    return new Promise((resolve, reject) => this.waiting.push({ type: command.type, resolve, reject }));
  }
}

describe("PiSession.runShell", () => {
  function setup() {
    const proc = new StubProc();
    const session = new PiSession(proc as unknown as PiRpcProcess, undefined, "/project", () => "/exports");
    const events: AgentEvent[] = [];
    session.onEvent((e) => events.push(e));
    return { proc, session, events };
  }

  it("sends bash with our id (no timeout), streams output, ends with the result", async () => {
    const { proc, session, events } = setup();
    const done = session.runShell({ id: "shell-1", command: "echo secret", shareWithAgent: false });
    expect(proc.calls[0]).toEqual({
      command: { type: "bash", id: "shell-1", command: "echo secret", excludeFromContext: true },
      timeoutMs: Number.POSITIVE_INFINITY,
    });
    proc.emit("event", { type: "bash_execution_update", id: "shell-1", delta: "secret\n" });
    proc.waiting[0]!.resolve({ output: "secret\n", exitCode: 0, cancelled: false, truncated: false });
    expect(await done).toEqual({ output: "secret\n", exitCode: 0, cancelled: false, truncated: false });
    expect(events.map((e) => e.type)).toEqual(["shell_start", "shell_update", "shell_end"]);
    expect(events[0]).toMatchObject({ type: "shell_start", id: "shell-1", command: "echo secret", shared: false });
    expect(events[2]).toMatchObject({ type: "shell_end", id: "shell-1", result: { output: "secret\n", exitCode: 0 } });
  });

  it("ends with an error instead of rejecting when pi fails; abortShell sends abort_bash", async () => {
    const { proc, session, events } = setup();
    const done = session.runShell({ id: "shell-2", command: "ls", shareWithAgent: true });
    expect(proc.calls[0]!.command.excludeFromContext).toBe(false);
    await session.abortShell();
    expect(proc.calls[1]!.command).toEqual({ type: "abort_bash" });
    proc.waiting[0]!.reject(new Error("pi process is not running"));
    expect(await done).toMatchObject({ exitCode: null, error: "pi process is not running" });
    expect(events.at(-1)).toMatchObject({ type: "shell_end", id: "shell-2", result: { error: "pi process is not running" } });
  });
});

describe("shell endpoints (FakeHarness)", () => {
  let env: TestEnv;
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(() => {
    env = createTestEnv();
    app = createApp({ service: env.service }).app;
  });
  afterEach(async () => {
    await env.cleanup();
  });

  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { host: "127.0.0.1:4317", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function newSession() {
    const created = await env.service.createWorkspace({ projectId: null });
    await flush();
    return created.session.session.id;
  }

  const shellMessages = async (sid: string) =>
    (await env.service.getSessionDetail(sid)).transcript.messages.filter((m): m is ShellMessage => m.role === "shell");

  it("runs a command, streams it to clients and keeps it in the transcript", async () => {
    const sid = await newSession();
    const res = await req("POST", `/api/sessions/${sid}/shell`, { command: " ls ", shareWithAgent: true });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^shell-/);
    await until(() => env.messages.some((m) => m.type === "session_event" && m.event.type === "shell_end"));
    const types = env.messages.flatMap((m) => (m.type === "session_event" && m.event.type.startsWith("shell_") ? [m.event.type] : []));
    expect(types).toEqual(["shell_start", "shell_update", "shell_update", "shell_end"]);
    const start = env.messages.find((m) => m.type === "session_event" && m.event.type === "shell_start");
    expect(start?.type === "session_event" && start.event.type === "shell_start" && typeof start.event.at).toBe("number");
    expect(await shellMessages(sid)).toEqual([
      expect.objectContaining({ id, command: "ls", shared: true, running: false, output: "fake output of: ls\n", exitCode: 0 }),
    ]);
    expect(env.harness.openSessions.values().next().value?.shells).toEqual([{ id, command: "ls", shareWithAgent: true }]);
  });

  it("!! commands are marked not shared; non-zero exit codes are kept", async () => {
    const sid = await newSession();
    await req("POST", `/api/sessions/${sid}/shell`, { command: "exit 3", shareWithAgent: false });
    await until(() => env.messages.some((m) => m.type === "session_event" && m.event.type === "shell_end"));
    expect(await shellMessages(sid)).toEqual([expect.objectContaining({ command: "exit 3", shared: false, exitCode: 3 })]);
  });

  it("runs while the agent is working and stops on abort", async () => {
    const sid = await newSession();
    const fake = env.harness.openSessions.values().next().value!;
    fake.emit({ type: "run_start" });
    fake.emit({ type: "state", state: { isRunning: true } });
    expect((await env.service.getSessionDetail(sid)).state.isRunning).toBe(true);
    const res = await req("POST", `/api/sessions/${sid}/shell`, { command: "sleep 30", shareWithAgent: true });
    expect(res.status).toBe(200);
    await until(() => env.messages.some((m) => m.type === "session_event" && m.event.type === "shell_start"));
    expect((await shellMessages(sid))[0]).toMatchObject({ running: true });
    expect((await req("POST", `/api/sessions/${sid}/shell/abort`)).status).toBe(204);
    await until(() => env.messages.some((m) => m.type === "session_event" && m.event.type === "shell_end"));
    expect((await shellMessages(sid))[0]).toMatchObject({ running: false, cancelled: true, exitCode: null });
  });

  it("validates the body, 404s unknown sessions, 501s harnesses without shell", async () => {
    const sid = await newSession();
    expect((await req("POST", `/api/sessions/${sid}/shell`, { command: "", shareWithAgent: true })).status).toBe(400);
    expect((await req("POST", `/api/sessions/${sid}/shell`, { command: "ls" })).status).toBe(400);
    expect((await req("POST", `/api/sessions/nope/shell`, { command: "ls", shareWithAgent: true })).status).toBe(404);
    env.harness.info.capabilities.shell = false;
    const res = await req("POST", `/api/sessions/${sid}/shell`, { command: "ls", shareWithAgent: true });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "Fake agent can't run shell commands" });
  });
});
