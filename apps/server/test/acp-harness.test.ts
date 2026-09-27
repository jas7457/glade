/**
 * I-119: the ACP harness against a scripted fake ACP agent (`fixtures/fake-acp-agent.mjs`, run
 * with this Node binary; no model, no network). Covers the handshake, streaming, tool calls,
 * permissions, file access confined to the chat's folder, cancel, errors, crashes and resuming
 * with `session/load` vs Glade's own transcript copy.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageText, type AcpAgentConfig, type AgentEvent, type AssistantMessage, type UiRequest } from "@glade/protocol";
import { AcpHarness, AcpHarnessProvider, ACP_CAPABILITIES } from "../src/harness/acp/acp-harness.js";
import type { AcpSession } from "../src/harness/acp/acp-session.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { AppService } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";
import { until } from "./helpers.js";

const AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

let dir: string;
let cwd: string;
let logFile: string;
let stateFile: string;
const open: AcpSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glade-acp-"));
  cwd = join(dir, "project");
  mkdirSync(cwd);
  logFile = join(dir, "agent-log.jsonl");
  stateFile = join(dir, "agent-state.json");
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  rmSync(dir, { recursive: true, force: true });
});

function config(env: Record<string, string> = {}, overrides: Partial<AcpAgentConfig> = {}): AcpAgentConfig {
  return { id: "fake", name: "Fake ACP", command: process.execPath, args: [AGENT], env: { FAKE_ACP_LOG: logFile, FAKE_ACP_STATE: stateFile, ...env }, ...overrides };
}

function harness(env: Record<string, string> = {}, overrides: Partial<AcpAgentConfig> = {}, cancelGraceMs?: number): AcpHarness {
  return new AcpHarness(config(env, overrides), { transcriptsDir: join(dir, "acp-sessions"), session: cancelGraceMs ? { cancelGraceMs } : {} });
}

async function openSession(h: AcpHarness, sessionRef: string | null = null) {
  const session = (await h.openSession({ cwd, sessionRef })) as AcpSession;
  open.push(session);
  const events: AgentEvent[] = [];
  const exits: Array<Error | null> = [];
  session.onEvent((e) => events.push(e));
  session.onExit((e) => exits.push(e));
  const runEnds = () => events.filter((e) => e.type === "run_end").length;
  /** Send a prompt and wait for its run to end. */
  const run = async (text: string) => {
    const before = runEnds();
    await session.prompt({ text });
    await until(() => runEnds() > before, 5000);
  };
  return { session, events, exits, run };
}

function agentLog(): Array<{ id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

function assistants(session: AcpSession): Promise<AssistantMessage[]> {
  return session.loadTranscript().then((t) => t.messages.filter((m): m is AssistantMessage => m.role === "assistant"));
}

async function lastText(session: AcpSession): Promise<string> {
  const list = await assistants(session);
  return messageText(list.at(-1)!);
}

describe("ACP harness", () => {
  it("describes itself from the agent's config with ACP's capabilities", () => {
    const h = harness();
    expect(h.id).toBe("acp-fake");
    expect(h.info.label).toBe("Fake ACP");
    expect(h.info.capabilities).toEqual(ACP_CAPABILITIES);
    expect(ACP_CAPABILITIES).toMatchObject({ uiRequests: true, commands: true, models: false, steering: false, shell: false, compact: false });
  });

  it("doesn't start the agent until the first prompt", async () => {
    const { session } = await openSession(harness());
    expect(session.sessionRef).toMatch(/^[0-9a-f-]{36}$/);
    await new Promise((r) => setTimeout(r, 50));
    expect(agentLog()).toEqual([]);
  });

  it("initializes, creates a session in the chat's folder and streams a reply", async () => {
    const h = harness();
    const { session, events, run } = await openSession(h);
    await run("hello");

    const log = agentLog();
    const init = log.find((m) => m.method === "initialize")!;
    expect(init.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false }, clientInfo: { name: "glade" } });
    expect(log.find((m) => m.method === "session/new")!.params).toEqual({ cwd, mcpServers: [] });
    expect(log.find((m) => m.method === "session/prompt")!.params).toMatchObject({ prompt: [{ type: "text", text: "hello" }] });

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run_start");
    expect(types.at(-1)).toBe("run_end");
    const transcript = await session.loadTranscript();
    expect(transcript.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    const reply = transcript.messages[1] as AssistantMessage;
    expect(reply.content).toEqual([
      { type: "thinking", text: "Thinking about it" },
      { type: "text", text: "Hello there!" },
    ]);
    expect(reply.stopReason).toBe("stop");
    expect(reply.streaming).toBe(false);
    // Deltas streamed one by one.
    expect(events.filter((e) => e.type === "block_delta").map((e) => (e as { delta: string }).delta)).toEqual(["Thinking about it", "Hello ", "there!"]);
    // usage_update → context meter; prompt usage → session totals.
    expect(session.getState().contextUsage).toEqual({ tokens: 5000, contextWindow: 100000, percent: 5 });
    expect(session.getState().sessionStats).toMatchObject({ cost: 0.01, tokens: { input: 20, output: 10, total: 30 } });
    expect(session.getState().isRunning).toBe(false);
    // Slash commands from available_commands_update.
    expect(await session.listCommands()).toEqual([{ name: "review", description: "Review the changes", source: "extension", argsHint: "[focus]" }]);
    // Glade keeps the transcript.
    expect((await h.readTranscript(session.sessionRef))?.messages).toHaveLength(2);
    expect(await h.readSessionText(session.sessionRef)).toMatchObject({ messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "Hello there!" }] });
    expect(await h.statSession(session.sessionRef)).toMatchObject({ size: expect.any(Number) });
  });

  it("maps tool calls and their updates, then continues in a new message", async () => {
    const { session, events, run } = await openSession(harness());
    await run("tool");
    const [toolMessage, answer] = await assistants(session);
    expect(toolMessage!.content).toEqual([
      { type: "toolCall", id: "t1", name: "Run ls", kind: "shell", input: { command: "ls -la", description: "Run ls" }, args: { command: "ls -la" } },
    ]);
    expect(toolMessage!.stopReason).toBe("toolUse");
    expect(messageText(answer!)).toBe("Listed.");
    const t = await session.loadTranscript();
    expect(t.toolResults.t1).toMatchObject({ status: "done", output: "file-a\nfile-b", toolName: "Run ls" });
    expect(events.some((e) => e.type === "tool_start" && e.toolCallId === "t1")).toBe(true);
  });

  it("maps edit diffs to normalized edits", async () => {
    const file = join(cwd, "a.txt");
    const { session, run } = await openSession(harness());
    await run(`edit ${file}`);
    const [message] = await assistants(session);
    expect(message!.content[0]).toMatchObject({ kind: "edit", input: { path: file, edits: [{ oldText: "old line", newText: "new line" }] } });
    expect((await session.loadTranscript()).toolResults.e1?.status).toBe("done");
  });

  it("shows a plan as one checklist notice updated in place", async () => {
    const { session, events, run } = await openSession(harness());
    await run("plan");
    const notices = (await session.loadTranscript()).messages.filter((m) => m.role === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "plan",
      plan: [
        { content: "Step one", status: "completed" },
        { content: "Step two", status: "in_progress" },
      ],
    });
    expect(messageText(notices[0]!)).toBe("Plan\n☑ Step one\n▸ Step two");
    // Both updates carried the same id (the card updates in place).
    const ids = events.flatMap((e) => (e.type === "message_end" && e.message.role === "notice" ? [e.message.id] : []));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
  });

  it("asks the user for permission and returns the chosen option", async () => {
    const { session, events } = await openSession(harness());
    await session.prompt({ text: "permission" });
    await until(() => events.some((e) => e.type === "ui_request"), 5000);
    const request = (events.find((e) => e.type === "ui_request") as { request: UiRequest }).request;
    expect(request).toMatchObject({
      kind: "permission",
      title: "Delete build/",
      message: "$ rm -rf build",
      toolCallId: "p1",
      options: [
        { id: "allow", label: "Allow once", kind: "allow_once" },
        { id: "always", label: "Always allow", kind: "allow_always" },
        { id: "reject", label: "Reject", kind: "reject_once" },
      ],
    });
    session.respondToUi({ id: request.id, value: "always" });
    await until(() => events.some((e) => e.type === "run_end"), 5000);
    expect(await lastText(session)).toBe("chose:always");
    expect((await session.loadTranscript()).toolResults.p1?.status).toBe("done");
    const answer = agentLog().find((m) => m.method === undefined && (m.result as { outcome?: unknown })?.outcome);
    expect(answer?.result).toEqual({ outcome: { outcome: "selected", optionId: "always" } });
  });

  it("marks a tool call the user rejected as rejected, not failed", async () => {
    const { session, events } = await openSession(harness());
    await session.prompt({ text: "permission" });
    await until(() => events.some((e) => e.type === "ui_request"), 5000);
    const request = (events.find((e) => e.type === "ui_request") as { request: UiRequest }).request;
    session.respondToUi({ id: request.id, value: "reject" });
    await until(() => events.some((e) => e.type === "run_end"), 5000);
    expect(await lastText(session)).toBe("chose:reject");
    expect((await session.loadTranscript()).toolResults.p1).toMatchObject({ status: "error", rejected: true });
  });

  it("answers a pending permission request `cancelled` when the run is stopped", async () => {
    const { session, events } = await openSession(harness());
    await session.prompt({ text: "permission" });
    await until(() => events.some((e) => e.type === "ui_request"), 5000);
    const request = (events.find((e) => e.type === "ui_request") as { request: UiRequest }).request;
    await session.abort();
    expect(events).toContainEqual({ type: "ui_request_closed", id: request.id });
    await until(() => events.some((e) => e.type === "run_end"), 5000);
    const [message] = await assistants(session);
    expect(message!.stopReason).toBe("aborted");
    expect(agentLog().some((m) => m.method === "session/cancel")).toBe(true);
    expect(agentLog().find((m) => (m.result as { outcome?: unknown })?.outcome)?.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("reads and writes files inside the chat's folder only", async () => {
    writeFileSync(join(cwd, "notes.txt"), "one\ntwo\nthree");
    const outside = join(dir, "secret.txt");
    writeFileSync(outside, "secret");
    symlinkSync(dir, join(cwd, "escape"));
    const { session, run } = await openSession(harness());

    await run(`read ${join(cwd, "notes.txt")}`);
    expect(await lastText(session)).toBe("read:one\ntwo\nthree");
    await run(`read ${join(cwd, "notes.txt")} 2 1`);
    expect(await lastText(session)).toBe("read:two");
    await run(`read ${outside}`);
    expect(await lastText(session)).toMatch(/^read-error:.*outside the chat's folder/);
    await run(`read ${join(cwd, "escape", "secret.txt")}`);
    expect(await lastText(session)).toMatch(/^read-error:.*outside the chat's folder/);
    await run("read notes.txt");
    expect(await lastText(session)).toMatch(/^read-error:.*must be absolute/);

    await run(`write ${join(cwd, "sub", "new.txt")} hello world`);
    expect(await lastText(session)).toBe("write:ok");
    expect(readFileSync(join(cwd, "sub", "new.txt"), "utf8")).toBe("hello world");
    await run(`write ${join(dir, "evil.txt")} nope`);
    expect(await lastText(session)).toMatch(/^write-error:.*outside the chat's folder/);
    expect(existsSync(join(dir, "evil.txt"))).toBe(false);
  });

  it("cancels a running turn with session/cancel", async () => {
    const { session, events } = await openSession(harness());
    await session.prompt({ text: "wait" });
    await until(() => events.some((e) => e.type === "block_delta"), 5000);
    await session.abort();
    await until(() => events.some((e) => e.type === "run_end"), 5000);
    const [message] = await assistants(session);
    expect(message!.stopReason).toBe("aborted");
    expect(messageText(message!)).toBe("Working…");
    expect(agentLog().filter((m) => m.method === "session/cancel")).toHaveLength(1);
  });

  it("ends the run anyway when the agent never confirms a cancel", async () => {
    const { session, events } = await openSession(harness({}, {}, 100));
    await session.prompt({ text: "ignore-cancel" });
    await until(() => events.some((e) => e.type === "block_delta"), 5000);
    await session.abort();
    await until(() => events.some((e) => e.type === "run_end"), 2000);
    expect(session.getState().isRunning).toBe(false);
  });

  it("queues messages sent while a turn runs and sends them afterwards", async () => {
    const { session, events } = await openSession(harness());
    await session.prompt({ text: "slow" });
    await session.prompt({ text: "hello" });
    expect(events).toContainEqual({ type: "state", state: { queue: { steering: [], followUp: ["hello"] } } });
    await until(() => events.filter((e) => e.type === "run_end").length === 2, 5000);
    const texts = (await assistants(session)).map((m) => messageText(m));
    expect(texts).toEqual(["slow done", "Hello there!"]);
    expect(session.getState().queue.followUp).toEqual([]);
  });

  it("keeps queued messages when the run is stopped and sends them after the next run (like pi)", async () => {
    const { session, events, run } = await openSession(harness());
    await session.prompt({ text: "wait" });
    await until(() => events.some((e) => e.type === "block_delta"), 5000);
    await session.prompt({ text: "hello" });
    await session.abort();
    await until(() => events.some((e) => e.type === "run_end"), 5000);
    await new Promise((r) => setTimeout(r, 100));
    expect(events.filter((e) => e.type === "run_start")).toHaveLength(1);
    expect(session.getState().queue.followUp).toEqual(["hello"]);
    // The next message runs first, then the queued one.
    await run("refuse");
    await until(() => events.filter((e) => e.type === "run_end").length === 2, 5000);
    expect(session.getState().queue.followUp).toEqual(["hello"]); // a failed run doesn't send it either
    await run("slow");
    await until(() => events.filter((e) => e.type === "run_end").length === 4, 5000);
    expect((await assistants(session)).map((m) => messageText(m)).slice(-2)).toEqual(["slow done", "Hello there!"]);
    expect(session.getState().queue.followUp).toEqual([]);
  });

  it("turns a failed prompt into an error message", async () => {
    const { session, run } = await openSession(harness());
    await run("error");
    const [message] = await assistants(session);
    expect(message).toMatchObject({ stopReason: "error", errorMessage: "Internal error", errorDetails: "model overloaded" });
    await run("refuse");
    expect((await assistants(session)).at(-1)).toMatchObject({ stopReason: "error", errorMessage: "The agent refused to continue." });
  });

  it("reports a crash mid-turn and exits the session", async () => {
    const { session, run, exits } = await openSession(harness());
    await run("crash");
    const [message] = await assistants(session);
    expect(message!.stopReason).toBe("error");
    expect(message!.errorMessage).toMatch(/code 3.*fake crash/s);
    await until(() => exits.length === 1);
    expect(exits[0]?.message).toMatch(/fake crash/);
  });

  it("explains a missing command and a required sign-in", async () => {
    const missing = await openSession(harness({}, { command: "glade-no-such-acp-agent" }));
    await missing.run("hello");
    expect((await assistants(missing.session))[0]?.errorMessage).toMatch(/command not found/);

    const auth = await openSession(harness({ FAKE_ACP_AUTH: "1" }));
    await auth.run("hello");
    expect((await assistants(auth.session))[0]?.errorMessage).toMatch(/needs you to sign in/);
  });

  it("resumes with session/load when supported, ignoring the replayed history", async () => {
    const h = harness({ FAKE_ACP_LOAD: "1" });
    const first = await openSession(h);
    await first.run("hello");
    const ref = first.session.sessionRef;
    await first.session.dispose();

    const second = await openSession(h, ref);
    // History comes from Glade's copy, before the agent starts.
    expect((await second.session.loadTranscript()).messages).toHaveLength(2);
    await second.run("history");
    const log = agentLog();
    expect(log.filter((m) => m.method === "session/new")).toHaveLength(1);
    expect(log.find((m) => m.method === "session/load")?.params).toMatchObject({ cwd, mcpServers: [] });
    expect(await lastText(second.session)).toBe("seen:2");
    // The replay (user + agent chunks) didn't duplicate anything.
    const t = await second.session.loadTranscript();
    expect(t.messages.map((m) => [m.role, messageText(m)])).toEqual([
      ["user", "hello"],
      ["assistant", "Hello there!"],
      ["user", "history"],
      ["assistant", "seen:2"],
    ]);
  });

  it("resumes with session/resume when the agent supports that instead", async () => {
    const h = harness({ FAKE_ACP_RESUME: "1" });
    const first = await openSession(h);
    await first.run("hello");
    await first.session.dispose();
    const second = await openSession(h, first.session.sessionRef);
    await second.run("history");
    expect(agentLog().some((m) => m.method === "session/resume")).toBe(true);
    expect(await lastText(second.session)).toBe("seen:2");
  });

  it("starts a new ACP session (with a notice) when the agent can't resume, keeping Glade's copy", async () => {
    const h = harness();
    const first = await openSession(h);
    await first.run("hello");
    await first.session.dispose();
    const second = await openSession(h, first.session.sessionRef);
    await second.run("history");
    expect(agentLog().filter((m) => m.method === "session/new")).toHaveLength(2);
    expect(await lastText(second.session)).toBe("seen:1");
    const t = await second.session.loadTranscript();
    expect(t.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "notice", "assistant"]);
    expect(messageText(t.messages[3]!)).toMatch(/started a new session/);
  });

  it("deletes Glade's transcript copy", async () => {
    const h = harness();
    const { session, run } = await openSession(h);
    await run("hello");
    await h.deleteSession(session.sessionRef);
    expect(await h.readTranscript(session.sessionRef)).toBeNull();
  });
});

describe("ACP agents in the registry", () => {
  it("lists configured agents as harnesses, reusing instances until their config changes", () => {
    let agents: unknown = [
      { id: "gem", name: "Gemini", command: "gemini", args: ["--acp"], env: {} },
      { id: "bad id!", name: "Broken", command: "x" },
      { id: "nocmd", name: "No command", command: "" },
    ];
    const provider = new AcpHarnessProvider(() => agents, { transcriptsDir: join(dir, "t") });
    const pi = new FakeHarness(undefined, 0, { id: "pi" });
    const registry = new HarnessRegistry([pi], { dynamic: () => provider.list() });
    expect(registry.list().map((h) => h.id)).toEqual(["pi", "acp-gem"]);
    const gem = registry.get("acp-gem");
    expect(gem?.info.label).toBe("Gemini");
    expect(registry.get("acp-gem")).toBe(gem);
    expect(registry.info().map((h) => [h.id, h.isDefault, h.capabilities.models])).toEqual([
      ["pi", true, undefined],
      ["acp-gem", false, false],
    ]);

    agents = [{ id: "gem", name: "Gemini CLI", command: "gemini", args: ["--acp"], env: {} }];
    expect(registry.get("acp-gem")).not.toBe(gem);
    expect(registry.get("acp-gem")?.info.label).toBe("Gemini CLI");
    agents = [];
    expect(registry.get("acp-gem")).toBeUndefined();
    expect(registry.list().map((h) => h.id)).toEqual(["pi"]);
  });

  it("can be the default harness when the setting names one", () => {
    const provider = new AcpHarnessProvider(() => [{ id: "gem", name: "Gemini", command: "gemini", args: [], env: {} }], { transcriptsDir: join(dir, "t") });
    const registry = new HarnessRegistry([new FakeHarness(undefined, 0, { id: "pi" })], { preferred: () => "acp-gem", dynamic: () => provider.list() });
    expect(registry.default().id).toBe("acp-gem");
  });
});

describe("ACP chats through the app service", () => {
  it("creates a chat in the chosen ACP agent and answers its permission request", async () => {
    const store = new Store(join(dir, "data"), 0);
    store.updateSettings({ harnesses: { acp: { agents: [config()] } } });
    const provider = new AcpHarnessProvider(() => store.getSettings().harnesses.acp.agents, { transcriptsDir: join(dir, "acp-sessions") });
    const registry = new HarnessRegistry([new FakeHarness(undefined, 0, { id: "pi" })], { dynamic: () => provider.list() });
    const service = new AppService({ store, harnesses: registry, scratchDir: cwd });
    try {
      expect(service.listHarnesses().map((h) => h.id)).toEqual(["pi", "acp-fake"]);
      await expect(service.createWorkspace({ projectId: null, harness: "acp-nope" })).rejects.toThrow(/isn't installed/);

      const created = await service.createWorkspace({ projectId: null, harness: "acp-fake", prompt: "permission", model: { provider: "fake", id: "smart" } });
      const session = created.session.session;
      expect(session.harness).toBe("acp-fake");
      expect(session.model).toBeNull();
      let detail = await service.getSessionDetail(session.id);
      await until(() => service.listSessions(created.workspace.id)[0]!.pendingInputs === 1, 5000);
      detail = await service.getSessionDetail(session.id);
      const request = detail.pendingUiRequests[0]!;
      expect(request.kind).toBe("permission");
      service.respondToUi(session.id, { id: request.id, value: "allow" });
      await until(() => !service.listSessions(created.workspace.id)[0]!.running, 5000);
      detail = await service.getSessionDetail(session.id);
      expect(detail.transcript.messages.map((m) => messageText(m)).at(-1)).toBe("chose:allow");

      // A new tab without a harness keeps the chat's agent (not the default one); an explicit one wins.
      const tab = await service.createSession(created.workspace.id, {});
      expect(tab.session.harness).toBe("acp-fake");
      const piTab = await service.createSession(created.workspace.id, { harness: "pi" });
      expect(piTab.session.harness).toBe("pi");
      await service.updateWorkspace(created.workspace.id, { layout: { activeMainSessionId: piTab.session.id } });
      expect((await service.createSession(created.workspace.id, {})).session.harness).toBe("pi");
      // A workspace with no sessions yet (a new chat) uses the default harness.
      expect((await service.createWorkspace({ projectId: null })).session.session.harness).toBe("pi");
    } finally {
      await service.dispose();
    }
  });

  it("shows a crash once: in the transcript, without a duplicate error banner", async () => {
    const store = new Store(join(dir, "data"), 0);
    store.updateSettings({ harnesses: { acp: { agents: [config()] } } });
    const provider = new AcpHarnessProvider(() => store.getSettings().harnesses.acp.agents, { transcriptsDir: join(dir, "acp-sessions") });
    const service = new AppService({ store, harnesses: new HarnessRegistry([new FakeHarness(undefined, 0, { id: "pi" })], { dynamic: () => provider.list() }), scratchDir: cwd });
    const events: AgentEvent[] = [];
    service.subscribe((m) => {
      if (m.type === "session_event") events.push(m.event);
    });
    try {
      const created = await service.createWorkspace({ projectId: null, harness: "acp-fake", prompt: "crash" });
      const id = created.session.session.id;
      await until(() => service.liveCount === 0, 5000);
      expect(events.some((e) => e.type === "message_end" && e.message.role === "assistant" && /fake crash/.test(e.message.errorMessage ?? ""))).toBe(true);
      expect(events.some((e) => e.type === "error")).toBe(false);
      expect(store.getSession(id)?.lastRunFailed).toBe(true);
    } finally {
      await service.dispose();
    }
  });
});
