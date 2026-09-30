import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, PermissionOption, Transcript } from "@glade/protocol";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { Conversation, chatVoiceBridge, newChatVoiceBridge, type ChatSnapshot, type VoiceChat } from "./conversation";
import { createFakeVoiceEngine, type FakeVoiceEngine } from "./fake-engine";

const api = vi.hoisted(() => ({ prompt: vi.fn(async () => undefined), respondToUi: vi.fn(async () => undefined) }));
vi.mock("@glade/app-core/lib/api", () => ({ api, request: vi.fn() }));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

const options: PermissionOption[] = [
  { id: "allow", label: "Yes", kind: "allow_once" },
  { id: "reject", label: "No, and tell Claude what to do differently", kind: "reject_once", focusComposer: true },
];

/** A scriptable chat. */
function fakeChat() {
  let listener: ((s: ChatSnapshot) => void) | null = null;
  let snap: ChatSnapshot = { isRunning: false, transcript: { messages: [], toolResults: {} }, permission: null, otherRequest: false };
  const sent: string[] = [];
  const responses: Array<[string, string]> = [];
  let sendResult: { ok: true } | { ok: false; message: string } = { ok: true };
  const chat: VoiceChat = {
    watch(onChange) {
      listener = onChange;
      onChange(snap);
      return () => (listener = null);
    },
    send: async (text) => {
      sent.push(text);
      return sendResult;
    },
    respond: (requestId, optionId) => {
      responses.push([requestId, optionId]);
      update({ permission: null });
    },
    agentName: () => "Claude Code",
    sessionId: () => "s1",
  };
  const update = (next: Partial<ChatSnapshot>) => {
    snap = { ...snap, ...next };
    listener?.(snap);
  };
  return { chat, sent, responses, update, failSends: (message: string) => (sendResult = { ok: false, message }) };
}

function transcriptWith(text: string): Transcript {
  const messages: ChatMessage[] = [
    { id: "u", role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
    { id: "a", role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", kind: "shell", args: {} }], timestamp: 1 },
    { id: "b", role: "assistant", content: [{ type: "text", text }], timestamp: 1, stopReason: "stop" },
  ];
  return { messages, toolResults: {} };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("Conversation", () => {
  let engine: FakeVoiceEngine;
  beforeEach(() => {
    vi.useFakeTimers();
    engine = createFakeVoiceEngine({ wordMs: 0, hearMs: 0 });
  });
  afterEach(() => vi.useRealTimers());

  it("a whole turn: listen, send, working ticks, read the reply with words, barge-in", async () => {
    const { chat, sent, update } = fakeChat();
    const c = new Conversation(engine, chat, { tickMs: 4000, voice: () => ({ voiceId: "v1", rate: 1.2 }) });
    c.start();
    await flush();
    expect(engine.sessionActive).toBe(true);
    expect(engine.listening).toBe(true);
    expect(c.state.value.phase.name).toBe("listening");
    expect(engine.cues).toEqual(["listening"]);

    await engine.hear("run the tests");
    expect(c.state.value.phase.name).toBe("sending");
    await flush();
    expect(sent).toEqual(["run the tests"]);

    update({ isRunning: true });
    expect(c.state.value.phase.name).toBe("working");
    expect(engine.cues).toEqual(["listening", "sent", "working"]);
    await vi.advanceTimersByTimeAsync(8100);
    expect(engine.cues.filter((q) => q === "working-tick")).toHaveLength(2);

    update({ isRunning: false, transcript: transcriptWith("All **good** here.") });
    expect(c.state.value.phase.name).toBe("speaking");
    expect(engine.speaking).toBe("I ran one command.\nAll good here.");
    expect(engine.calls.find((x) => x.method === "speak")!.args[1]).toEqual({ voiceId: "v1", rate: 1.2 });
    // No more ticks.
    await vi.advanceTimersByTimeAsync(9000);
    expect(engine.cues.filter((q) => q === "working-tick")).toHaveLength(2);

    engine.step();
    engine.step();
    expect(c.state.value.phase).toMatchObject({ name: "speaking", word: [2, 5] });

    // Barge-in.
    engine.emitListen({ type: "speech-start" });
    expect(engine.speaking).toBeNull();
    expect(c.state.value.phase.name).toBe("listening");
  });

  it("finishing the reply goes back to listening", async () => {
    const { chat, update } = fakeChat();
    const c = new Conversation(engine, chat);
    c.start();
    await flush();
    update({ isRunning: true });
    update({ isRunning: false, transcript: transcriptWith("Done") });
    engine.finishSpeaking();
    expect(c.state.value.phase.name).toBe("listening");
  });

  it("a run too quick to be seen still gets its reply read", async () => {
    const { chat, update } = fakeChat();
    const c = new Conversation(engine, chat);
    c.start();
    await flush();
    await engine.hear("hi");
    await flush();
    update({ transcript: transcriptWith("Quick one") });
    expect(c.state.value.phase.name).toBe("speaking");
    expect(engine.speaking).toContain("Quick one");
  });

  it("a permission card: read, answered 'no', then what to do instead is sent", async () => {
    const { chat, sent, responses, update } = fakeChat();
    const c = new Conversation(engine, chat);
    c.start();
    await flush();
    update({ isRunning: true, permission: { id: "q1", kind: "permission", title: "Allow Bash?", message: "rm -rf build", options } });
    expect(engine.speaking).toBe("Claude Code wants to use Bash: rm -rf build. Allow?");
    engine.finishSpeaking();
    await engine.hear("no");
    expect(responses).toEqual([["q1", "reject"]]);
    expect(engine.speaking).toBe("OK. What should I do instead?");
    update({ isRunning: false });
    engine.finishSpeaking();
    expect(c.state.value.phase).toMatchObject({ name: "asking", step: "instead" });
    await engine.hear("delete only the cache");
    await flush();
    expect(sent).toEqual(["delete only the cache"]);
  });

  it("send failure → error, Retry sends again", async () => {
    const { chat, sent, failSends } = fakeChat();
    const c = new Conversation(engine, chat);
    c.start();
    await flush();
    failSends("offline");
    await engine.hear("hello");
    await flush();
    expect(c.state.value.phase).toMatchObject({ name: "error", message: "offline" });
    c.dispatch({ type: "retry" });
    await flush();
    expect(sent).toEqual(["hello", "hello"]);
  });

  it("asks for permissions; denied → unavailable", async () => {
    engine = createFakeVoiceEngine({ permissions: { microphone: "undetermined", speechRecognition: "undetermined" }, grant: { microphone: "granted", speechRecognition: "denied" } });
    const c = new Conversation(engine, fakeChat().chat);
    c.start();
    await flush();
    expect(engine.calls.map((x) => x.method)).toContain("requestPermissions");
    expect(c.state.value.phase).toEqual({ name: "unavailable", reason: "denied" });
    expect(engine.sessionActive).toBe(false);
  });

  it("unsupported device → unavailable", async () => {
    engine = createFakeVoiceEngine({ available: false });
    const c = new Conversation(engine, fakeChat().chat);
    c.start();
    await flush();
    expect(c.state.value.phase).toEqual({ name: "unavailable", reason: "unsupported" });
  });

  it("close ends the session", async () => {
    const c = new Conversation(engine, fakeChat().chat);
    c.start();
    await flush();
    c.close();
    await flush();
    expect(engine.sessionActive).toBe(false);
    expect(engine.listening).toBe(false);
  });
});

describe("chat bridges", () => {
  beforeEach(() => {
    resetChatSessions();
    api.prompt.mockClear();
    api.respondToUi.mockClear();
  });

  it("watches a chat's state and answers its permission card", async () => {
    const store = getChatSession("s1");
    const bridge = chatVoiceBridge("s1");
    const seen: ChatSnapshot[] = [];
    const stop = bridge.watch((s) => seen.push(s));
    store.state.value = { ...store.state.value, isRunning: true };
    store.uiRequests.value = [{ id: "q", kind: "permission", title: "Allow?", options }];
    expect(seen.at(-1)).toMatchObject({ isRunning: true, permission: { id: "q" }, otherRequest: false });
    bridge.respond("q", "allow");
    expect(store.uiRequests.value).toEqual([]);
    expect(api.respondToUi).toHaveBeenCalledWith("s1", { id: "q", value: "allow" });
    expect(await bridge.send("more")).toEqual({ ok: true });
    expect(api.prompt).toHaveBeenCalledWith("s1", expect.objectContaining({ text: "more" }));
    stop();
  });

  it("New Chat: the first send starts the chat, then it's that chat", async () => {
    const start = vi.fn(async () => "new1");
    const created = vi.fn();
    const bridge = newChatVoiceBridge(start, created);
    const seen: ChatSnapshot[] = [];
    bridge.watch((s) => seen.push(s));
    expect(bridge.sessionId()).toBeNull();
    expect(await bridge.send("build a thing")).toEqual({ ok: true });
    expect(start).toHaveBeenCalledWith("build a thing");
    expect(created).toHaveBeenCalledWith("new1");
    expect(bridge.sessionId()).toBe("new1");
    const store = getChatSession("new1");
    store.state.value = { ...store.state.value, isRunning: true };
    expect(seen.at(-1)?.isRunning).toBe(true);
    await bridge.send("and test it");
    expect(start).toHaveBeenCalledTimes(1);
    expect(api.prompt).toHaveBeenCalledWith("new1", expect.objectContaining({ text: "and test it" }));
  });

  it("New Chat: a failed start is a send failure", async () => {
    const bridge = newChatVoiceBridge(async () => null);
    bridge.watch(() => {});
    expect(await bridge.send("x")).toEqual({ ok: false, message: "Could not start the chat" });
  });
});
