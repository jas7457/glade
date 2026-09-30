/**
 * I-188: a harness's own sub-agents (Claude Code's Task tool, Codex's spawn_agent) as read-only
 * `subagent` sessions: created on `native_subagent_start`, streamed and stored like any chat,
 * ended with their report, linked to the parent's call, never started or messaged, ended with
 * the parent. Driven through the fake harness's native events (`emitNative`, `native …` prompts).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { messageText, type AgentEvent, type SessionSummary } from "@glade/protocol";
import type { FakeSession } from "../src/harness/fake/fake-harness.js";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { AppService, HttpError } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";
import { createTestEnv, flush, newChat, until, type TestEnv } from "./helpers.js";

let env: TestEnv;

beforeEach(() => {
  env = createTestEnv();
  env.harness.script = () => [];
});
afterEach(async () => {
  await env.cleanup();
});

function fakeOf(sessionId: string): FakeSession {
  const ref = env.store.getSession(sessionId)!.sessionRef;
  return [...env.harness.openSessions].find((s) => s.sessionRef === ref)!;
}
const subagentsOf = (wid: string, parent: string): SessionSummary[] => env.service.listSessions(wid).filter((s) => s.parentSessionId === parent);

/** A parent chat running a turn with a Task call `call-1`. */
async function parentWithCall() {
  const chat = await newChat(env, { prompt: "go" });
  await until(() => !env.service.listSessions(chat.wid)[0]!.running);
  const fake = fakeOf(chat.sid);
  const call = { type: "toolCall" as const, id: "call-1", name: "Task", kind: "task" as const, input: { description: "Count files" }, args: {} };
  fake.emit({ type: "run_start" });
  fake.emit({ type: "message_end", message: { id: "p1", role: "assistant", content: [call], timestamp: 1, stopReason: "toolUse" } });
  return { ...chat, fake };
}

const text = (id: string, messageId: string, t: string): AgentEvent[] => [
  { type: "message_start", message: { id: messageId, role: "assistant", content: [], timestamp: 2, streaming: true } },
  { type: "block_start", messageId, index: 0, block: { type: "text", text: "" } },
  { type: "block_delta", messageId, index: 0, delta: t },
];

describe("native sub-agents (I-188)", () => {
  it("mirrors a native sub-agent as a read-only sub-agent session: start, stream, report, link, store", async () => {
    const { wid, sid, fake } = await parentWithCall();
    fake.emitNative({ type: "native_subagent_start", id: "a1", toolCallId: "call-1", name: "Explore", title: "Count files", task: "Count the files in src" });
    const [child] = subagentsOf(wid, sid);
    expect(child).toMatchObject({ kind: "subagent", agentName: "explore", title: "Count files", harness: "fake", running: true, status: "working" });
    expect(child!.agentDisplayName).toBeTruthy();
    expect(child!.agent).toMatchObject({ status: "working", task: "Count the files in src", native: "Fake agent" });
    // The parent links its call to the agent.
    const parent = env.service.listSessions(wid).find((s) => s.id === sid)!;
    expect(parent.spawnedAgents).toEqual([expect.objectContaining({ name: "explore", sessionId: child!.id, toolCallId: "call-1", native: true })]);

    // Its conversation streams into its own session (live detail) and the store.
    for (const event of text("a1", "m1", "There are 3")) fake.emitNative({ type: "native_subagent_event", id: "a1", event });
    const call = { type: "toolCall" as const, id: "b1", name: "Bash", kind: "shell" as const, input: { command: "ls" }, args: { command: "ls" } };
    fake.emitNative({ type: "native_subagent_event", id: "a1", event: { type: "message_end", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "There are 3" }, call], timestamp: 3, stopReason: "toolUse" } } });
    fake.emitNative({ type: "native_subagent_event", id: "a1", event: { type: "tool_start", toolCallId: "b1", toolName: "Bash", args: {} } });
    fake.emitNative({ type: "native_subagent_event", id: "a1", event: { type: "tool_end", toolCallId: "b1", result: { toolCallId: "b1", toolName: "Bash", status: "done", output: "a\nb\nc\n" } } });
    const live = await env.service.getSessionDetail(child!.id);
    expect(live.transcript.messages.map((m) => [m.role, messageText(m)])).toEqual([
      ["user", "Count the files in src"],
      ["assistant", "There are 3"],
    ]);
    expect(live.state.isRunning).toBe(true);
    // The parent's own transcript doesn't get the sub-agent's messages.
    expect((await env.service.getSessionDetail(sid)).transcript.messages.some((m) => messageText(m).includes("There are 3"))).toBe(false);

    fake.emitNative({ type: "native_subagent_end", id: "a1", status: "done", result: "There are 3 files." });
    const done = subagentsOf(wid, sid)[0]!;
    expect(done).toMatchObject({ running: false, agent: { status: "done", result: "There are 3 files.", native: "Fake agent" } });
    expect(done.agent!.doneAt).toBeGreaterThan(0);
    const stored = env.store.loadTranscript(child!.id);
    expect(stored.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(stored.toolResults.b1).toMatchObject({ status: "done", output: "a\nb\nc\n" });
    // Later events for it are dropped.
    fake.emitNative({ type: "native_subagent_event", id: "a1", event: { type: "notify", level: "info", message: "late" } });

    // Viewing it again reads the store without starting anything; typing in it is refused.
    const opened = env.harness.openSessions.size;
    const detail = await env.service.getSessionDetail(child!.id);
    expect(detail.offline).toBe(true);
    expect(detail.transcript.messages).toHaveLength(2);
    expect(env.harness.openSessions.size).toBe(opened);
    await expect(env.service.prompt(child!.id, { text: "hi" })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Fake agent.s own sub-agent/) });
    expect(env.harness.openSessions.size).toBe(opened);
  });

  it("keeps it after a restart: closed, readable, never started", async () => {
    const { wid, sid, fake } = await parentWithCall();
    fake.emitNative({ type: "native_subagent_start", id: "a1", toolCallId: "call-1", name: "worker", task: "Work" });
    for (const event of text("a1", "m1", "Halfway")) fake.emitNative({ type: "native_subagent_event", id: "a1", event });
    const childId = subagentsOf(wid, sid)[0]!.id;
    env.service.flushTranscripts();
    // The server stops without ending it (quit mid-run): the next server sees it cut off.
    const dataDir = env.store.dataDir;
    await env.service.dispose();
    const store = new Store(dataDir, 0);
    const harness = new FakeHarness();
    const service = new AppService({ store, harnesses: new HarnessRegistry([harness]), scratchDir: join(env.dir, "scratch") });
    try {
      const child = service.listSessions(wid).find((s) => s.id === childId)!;
      expect(child).toMatchObject({ running: false, agent: { status: "closed", native: "Fake agent" } });
      const detail = await service.getSessionDetail(childId);
      expect(detail.transcript.messages.map((m) => messageText(m))).toEqual(["Work", "Halfway"]);
      expect(harness.openSessions.size).toBe(0);
      await expect(service.prompt(childId, { text: "go on" })).rejects.toBeInstanceOf(HttpError);
    } finally {
      await service.dispose();
    }
    const { dir } = env;
    env = { ...env, cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
  });

  it("runs several at once (the fake's `native 2 …`), each with its own name and colour, all reporting", async () => {
    env.harness.eventDelayMs = 0;
    const chat = await newChat(env);
    fakeOf(chat.sid).nativeStepMs = 5;
    await env.service.prompt(chat.sid, { text: "native 2 count the files" });
    await until(() => subagentsOf(chat.wid, chat.sid).length === 2 && subagentsOf(chat.wid, chat.sid).every((s) => s.agent?.status === "done"));
    const children = subagentsOf(chat.wid, chat.sid);
    expect(new Set(children.map((c) => c.agentDisplayName)).size).toBe(2);
    expect(new Set(children.map((c) => c.agentColor)).size).toBe(2);
    expect(children.map((c) => c.agent!.result).sort()).toEqual(["There are 3 files in src.", "There are 4 files in src."]);
    await until(() => !env.service.listSessions(chat.wid)[0]!.running);
    const parent = env.service.listSessions(chat.wid).find((s) => s.id === chat.sid)!;
    const transcript = (await env.service.getSessionDetail(chat.sid)).transcript;
    // Each Task call links to its agent; its result is the report.
    for (const ref of parent.spawnedAgents!) expect(transcript.toolResults[ref.toolCallId!]?.output).toMatch(/files in src/);
  });

  it("ends them when the parent is stopped, and when its process exits", async () => {
    env.harness.eventDelayMs = 0;
    const chat = await newChat(env);
    const fake = fakeOf(chat.sid);
    fake.nativeStepMs = 10_000;
    await env.service.prompt(chat.sid, { text: "native 2 slow" });
    await until(() => subagentsOf(chat.wid, chat.sid).length === 2);
    await env.service.abort(chat.sid);
    await until(() => subagentsOf(chat.wid, chat.sid).every((s) => !s.running));
    expect(subagentsOf(chat.wid, chat.sid).map((s) => s.agent!.status)).toEqual(["closed", "closed"]);

    // A harness that doesn't end them itself: the parent's process exiting does.
    fake.emitNative({ type: "native_subagent_start", id: "x", name: "worker", task: "Work" });
    const x = subagentsOf(chat.wid, chat.sid).find((s) => s.agentName === "worker")!;
    expect(x.running).toBe(true);
    fake.crash();
    await until(() => !subagentsOf(chat.wid, chat.sid).find((s) => s.id === x.id)!.running);
    expect(subagentsOf(chat.wid, chat.sid).find((s) => s.id === x.id)!.agent).toMatchObject({ status: "closed", result: expect.stringMatching(/exited/) });
  });

  it("stops one from its tab (Stop) through the parent's harness", async () => {
    env.harness.eventDelayMs = 0;
    const chat = await newChat(env);
    fakeOf(chat.sid).nativeStepMs = 10_000;
    await env.service.prompt(chat.sid, { text: "native 2 slow" });
    await until(() => subagentsOf(chat.wid, chat.sid).length === 2);
    const [first, second] = subagentsOf(chat.wid, chat.sid);
    await env.service.abort(first!.id);
    await until(() => !subagentsOf(chat.wid, chat.sid).find((s) => s.id === first!.id)!.running);
    expect(subagentsOf(chat.wid, chat.sid).find((s) => s.id === second!.id)!.running).toBe(true);
    await env.service.abort(chat.sid);
  });

  it("closing its tab deletes it quietly; later events are dropped; the agent API doesn't list it", async () => {
    const { wid, sid, fake } = await parentWithCall();
    fake.emitNative({ type: "native_subagent_start", id: "a1", toolCallId: "call-1", name: "worker", task: "Work" });
    const child = subagentsOf(wid, sid)[0]!;
    expect(env.service.listAgents(sid).agents).toEqual([]);
    const prompts = fake.prompts.length;
    await env.service.deleteSession(child.id);
    await flush(5);
    expect(subagentsOf(wid, sid)).toEqual([]);
    for (const event of text("a1", "m1", "Still here")) fake.emitNative({ type: "native_subagent_event", id: "a1", event });
    fake.emitNative({ type: "native_subagent_end", id: "a1", status: "done", result: "ok" });
    expect(subagentsOf(wid, sid)).toEqual([]);
    expect(env.store.getSession(child.id)).toBeUndefined();
    // Its parent isn't told (it's the harness's own agent, not Glade's).
    await flush(5);
    expect(fake.prompts.length).toBe(prompts);
  });

  it("starts one on its first event when the harness never announced it", async () => {
    const { wid, sid, fake } = await parentWithCall();
    for (const event of text("zz", "m1", "Hello")) fake.emitNative({ type: "native_subagent_event", id: "zz", event });
    const [child] = subagentsOf(wid, sid);
    expect(child).toMatchObject({ agentName: "agent", running: true });
    fake.emitNative({ type: "native_subagent_end", id: "zz", status: "error", result: "It broke" });
    expect(subagentsOf(wid, sid)[0]).toMatchObject({ running: false, lastRunFailed: true, agent: { status: "closed", result: "It broke" } });
  });
});
