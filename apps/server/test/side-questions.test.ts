/**
 * Side questions (`/btw`, I-140): the endpoints end to end against FakeHarness (streamed canned
 * answer, Stop, Dismiss, persistence outside the harness's context, model choice), and the pi
 * runner with a stubbed process (never a real model).
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAgentEvent, type AgentEvent, type SideQuestionMessage, type Transcript } from "@glade/protocol";
import { createApp } from "../src/http/app.js";
import { fakeSideAnswer } from "../src/harness/fake/fake-harness.js";
import { piSideQuestion, sideQuestionArgs, type SpawnFn } from "../src/harness/pi/side-question.js";
import { mergeTranscripts } from "../src/store/transcript-rows.js";
import { createTestEnv, flush, until, type TestEnv } from "./helpers.js";

describe("side question endpoints (FakeHarness)", () => {
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

  async function newSession(prompt?: string) {
    const created = await env.service.createWorkspace({ projectId: null, ...(prompt ? { prompt } : {}) });
    const sid = created.session.session.id;
    if (prompt) await until(() => env.messages.some((m) => m.type === "session_event" && m.sessionId === sid && m.event.type === "run_end"));
    await flush();
    return sid;
  }

  const sideEvents = (sid: string) =>
    env.messages.flatMap((m) => (m.type === "session_event" && m.sessionId === sid && m.event.type.startsWith("side_") ? [m.event] : []));
  const ended = (sid: string) => () => sideEvents(sid).some((e) => e.type === "side_end");
  const sideMessages = async (sid: string) =>
    (await env.service.getSessionDetail(sid)).transcript.messages.filter((m): m is SideQuestionMessage => m.role === "side");
  const fakeSession = () => [...env.harness.openSessions].at(-1)!;

  async function ask(sid: string, question: string) {
    const res = await req("POST", `/api/sessions/${sid}/side-questions`, { question });
    expect(res.status).toBe(200);
    return ((await res.json()) as { id: string }).id;
  }

  it("streams a canned answer over the chat's context and keeps it in Glade's store only", async () => {
    const sid = await newSession("build the parser");
    const id = await ask(sid, " what is it doing? ");
    expect(id).toMatch(/^side-/);
    await until(ended(sid));

    const events = sideEvents(sid);
    expect(events[0]).toMatchObject({ type: "side_start", id, question: "what is it doing?", model: "fake/smart" });
    expect(typeof (events[0] as { at?: number }).at).toBe("number");
    expect(events.filter((e) => e.type === "side_delta").length).toBeGreaterThan(3);
    const answer = fakeSideAnswer("what is it doing?");
    expect(events.at(-1)).toMatchObject({ type: "side_end", id, status: "done", answer });
    expect(await sideMessages(sid)).toEqual([expect.objectContaining({ id, role: "side", question: "what is it doing?", answer, status: "done" })]);

    // The harness got the conversation so far + the question, with its side-question system prompt.
    const call = env.harness.sideQuestions[0]!;
    expect(call.prompt).toContain("USER:\nbuild the parser");
    expect(call.prompt).toContain("You said: build the parser");
    expect(call.prompt.endsWith("Side question: what is it doing?")).toBe(true);
    expect(call.systemPrompt).toMatch(/side question/);

    // The agent never saw it: no prompt, and the harness's own session has no trace of it.
    const fake = fakeSession();
    expect(fake.prompts.map((p) => p.text)).toEqual(["build the parser"]);
    const harnessText = JSON.stringify(env.harness.sessions.get(fake.sessionRef)!.transcript);
    expect(harnessText).not.toContain("what is it doing?");

    // Stored with the chat (the store's copy, as a reload reads it).
    const stored = env.store.loadTranscript(sid).messages.find((m) => m.id === id);
    expect(stored).toMatchObject({ role: "side", status: "done", answer });
  });

  it("answers while the agent is working, including the turn in progress, without touching the run", async () => {
    const sid = await newSession();
    const fake = fakeSession();
    fake.emit({ type: "run_start" });
    fake.emit({ type: "state", state: { isRunning: true } });
    fake.emit({ type: "message_start", message: { id: "a1", role: "assistant", content: [{ type: "text", text: "Refactoring the lexer" }], timestamp: 1, streaming: true } });
    await ask(sid, "which file?");
    await until(ended(sid));
    expect(env.harness.sideQuestions[0]!.prompt).toContain("Refactoring the lexer");
    expect(env.harness.sideQuestions[0]!.prompt).toContain("[still writing…]");
    const detail = await env.service.getSessionDetail(sid);
    expect(detail.state.isRunning).toBe(true);
    expect(fake.prompts).toEqual([]);
  });

  it("Stop keeps the partial answer; Dismiss hides the card and is stored", async () => {
    const sid = await newSession();
    env.harness.sideAnswerDelayMs = 30;
    const id = await ask(sid, "slow one");
    await until(() => sideEvents(sid).filter((e) => e.type === "side_delta").length >= 2);
    expect((await sideMessages(sid))[0]).toMatchObject({ status: "streaming" });
    expect((await req("POST", `/api/sessions/${sid}/side-questions/${id}/stop`)).status).toBe(204);
    await until(ended(sid));
    const [card] = await sideMessages(sid);
    expect(card).toMatchObject({ status: "stopped" });
    expect(card!.answer.length).toBeGreaterThan(0);
    expect(card!.answer.length).toBeLessThan(fakeSideAnswer("slow one").length);

    expect((await req("POST", `/api/sessions/${sid}/side-questions/${id}/dismiss`)).status).toBe(204);
    expect((await sideMessages(sid))[0]).toMatchObject({ dismissed: true });
    await flush(5);
    expect(env.store.loadTranscript(sid).messages.find((m) => m.id === id)).toMatchObject({ dismissed: true });
  });

  it("uses the Side questions model when the harness lists it, else the chat's", async () => {
    const sid = await newSession();
    env.store.updateSettings({ models: { sideQuestionModel: { provider: "fake", id: "fast" } } });
    await ask(sid, "q1");
    await until(ended(sid));
    expect(env.harness.sideQuestions[0]!.model).toEqual({ provider: "fake", id: "fast" });
    env.store.updateSettings({ models: { sideQuestionModel: { provider: "gone", id: "x" } } });
    await ask(sid, "q2");
    await until(() => sideEvents(sid).filter((e) => e.type === "side_end").length === 2);
    expect(env.harness.sideQuestions[1]!.model).toEqual({ provider: "fake", id: "smart" });
  });

  it("reports failures on the card", async () => {
    const sid = await newSession();
    env.harness.sideAnswerError = "provider says no";
    await ask(sid, "q");
    await until(ended(sid));
    expect((await sideMessages(sid))[0]).toMatchObject({ status: "error", error: "provider says no" });
  });

  it("finishes in the store when the chat's process stops meanwhile", async () => {
    const sid = await newSession();
    env.harness.sideAnswerDelayMs = 20;
    const id = await ask(sid, "still there?");
    await until(() => sideEvents(sid).some((e) => e.type === "side_delta"));
    await (env.service as unknown as { closeLive(id: string): Promise<void> }).closeLive(sid);
    await until(ended(sid), 5000);
    expect(env.store.loadTranscript(sid).messages.find((m) => m.id === id)).toMatchObject({ status: "done", answer: fakeSideAnswer("still there?") });
  });

  it("validates the body, 404s unknown sessions, 501s harnesses without side questions", async () => {
    const sid = await newSession();
    expect((await req("POST", `/api/sessions/${sid}/side-questions`, { question: "  " })).status).toBe(400);
    expect((await req("POST", `/api/sessions/${sid}/side-questions`, {})).status).toBe(400);
    expect((await req("POST", `/api/sessions/nope/side-questions`, { question: "q" })).status).toBe(404);
    env.harness.info.capabilities.sideQuestions = false;
    const res = await req("POST", `/api/sessions/${sid}/side-questions`, { question: "q" });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "Fake agent can't answer side questions" });
  });
});

describe("side questions in stored conversations", () => {
  it("an import from the harness's file keeps the side cards (they're never in it)", () => {
    const side: SideQuestionMessage = { id: "s1", role: "side", question: "q", answer: "a", status: "done", timestamp: 3 };
    const stored: Transcript = {
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
        side,
        { id: "a1", role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 },
      ],
      toolResults: {},
    };
    const imported: Transcript = {
      messages: [
        { id: "h0", role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
        { id: "h1", role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 },
      ],
      toolResults: {},
    };
    const merged = mergeTranscripts(stored, imported, () => "new");
    expect(merged.added).toBe(0);
    expect(merged.transcript.messages.map((m) => m.id)).toEqual(["u1", "s1", "a1"]);
  });
});

// ---------------------------------------------------------------------------------------------
// pi: a throwaway `pi -p --mode json` (stubbed process)
// ---------------------------------------------------------------------------------------------

class StubChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  stdinText = "";
  killed: string | null = null;
  constructor() {
    super();
    this.stdin.on("data", (c: Buffer) => (this.stdinText += c.toString()));
  }
  kill(signal: string) {
    this.killed = signal;
    setImmediate(() => this.emit("close", null));
    return true;
  }
  line(event: unknown) {
    this.stdout.write(`${JSON.stringify(event)}\n`);
  }
  close(code: number) {
    this.stdout.end();
    setImmediate(() => this.emit("close", code));
  }
}

function stubSpawn() {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  let child!: StubChild;
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    child = new StubChild();
    return child as unknown as ChildProcess;
  };
  return { calls, spawn, child: () => child };
}

const delta = (text: string) => ({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });

describe("piSideQuestion", () => {
  it("runs pi without tools or session, the prompt on stdin, and streams the answer", async () => {
    const stub = stubSpawn();
    const deltas: string[] = [];
    const controller = new AbortController();
    const done = piSideQuestion({
      piPath: "/bin/pi",
      spawn: stub.spawn,
      extraArgs: ["--offline"],
      prompt: "<conversation>…</conversation>\n\nSide question: why?",
      systemPrompt: "SYS",
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
      cwd: "/project",
      signal: controller.signal,
      onDelta: (d) => deltas.push(d),
    });
    const child = stub.child();
    expect(stub.calls[0]).toEqual({
      command: "/bin/pi",
      cwd: "/project",
      args: [
        "-p",
        "--mode",
        "json",
        "--no-session",
        "--no-tools",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--system-prompt",
        "SYS",
        "--model",
        "anthropic/claude-haiku-4-5",
        "--thinking",
        "off",
        "--offline",
      ],
    });
    child.line({ type: "session", version: 3 });
    child.stdout.write("not json from an extension\n");
    child.line({ type: "message_start", message: { role: "assistant", content: [] } });
    child.line(delta("Because "));
    child.line(delta("of X."));
    child.line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Because of X." }], stopReason: "stop" } });
    child.close(0);
    expect(await done).toEqual({ answer: "Because of X." });
    expect(deltas).toEqual(["Because ", "of X."]);
    expect(child.stdinText).toBe("<conversation>…</conversation>\n\nSide question: why?");
  });

  it("without a model it lets pi pick its default", () => {
    expect(sideQuestionArgs("S", null)).not.toContain("--model");
  });

  it("Stop kills the process and keeps the partial answer", async () => {
    const stub = stubSpawn();
    const controller = new AbortController();
    const done = piSideQuestion({ piPath: "pi", spawn: stub.spawn, prompt: "p", systemPrompt: "s", model: null, cwd: "/", signal: controller.signal, onDelta: () => {} });
    stub.child().line(delta("Half an"));
    await flush(5);
    controller.abort();
    expect(await done).toEqual({ answer: "Half an" });
    expect(stub.child().killed).toBe("SIGTERM");
  });

  it("reports provider errors and failed starts", async () => {
    const stub = stubSpawn();
    const signal = new AbortController().signal;
    const failed = piSideQuestion({ piPath: "pi", spawn: stub.spawn, prompt: "p", systemPrompt: "s", model: null, cwd: "/", signal, onDelta: () => {} });
    stub.child().line({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limited" } });
    stub.child().close(0);
    expect(await failed).toEqual({ answer: "", error: "429 rate limited" });

    const crashed = piSideQuestion({ piPath: "pi", spawn: stub.spawn, prompt: "p", systemPrompt: "s", model: null, cwd: "/", signal, onDelta: () => {} });
    stub.child().stderr.write("Error: no API key for provider\n");
    await flush(5);
    stub.child().close(1);
    expect(await crashed).toEqual({ answer: "", error: "Error: no API key for provider" });
  });
});

describe("side question events fold into a card", () => {
  it("start, deltas, end, dismiss", () => {
    const events: AgentEvent[] = [
      { type: "side_start", id: "s", question: "q", model: "p/m", at: 5 },
      { type: "side_delta", id: "s", delta: "An" },
      { type: "side_delta", id: "s", delta: "swer" },
      { type: "side_end", id: "s", status: "done", at: 9 },
      { type: "side_delta", id: "s", delta: "late" },
      { type: "side_dismiss", id: "s" },
    ];
    const t = events.reduce(applyAgentEvent, { messages: [], toolResults: {} } as Transcript);
    expect(t.messages).toEqual([
      { id: "s", role: "side", question: "q", answer: "Answer", status: "done", model: "p/m", timestamp: 5, endedAt: 9, dismissed: true },
    ]);
  });
});
