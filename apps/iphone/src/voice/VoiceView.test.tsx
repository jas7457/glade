/** Conversation mode's view (I-180) over a fake engine and a scripted chat. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/preact";
import type { ChatMessage, PermissionOption } from "@glade/protocol";
import { Conversation, type ChatSnapshot, type VoiceChat } from "./conversation";
import { createFakeVoiceEngine, type FakeVoiceEngine } from "./fake-engine";
import { VoiceView } from "./VoiceView";

const options: PermissionOption[] = [
  { id: "allow", label: "Yes", kind: "allow_once" },
  { id: "always", label: "Yes, and don't ask again for git", kind: "allow_always" },
  { id: "reject", label: "No, and tell Claude what to do differently", kind: "reject_once", focusComposer: true },
];

function setup(engineOptions: Parameters<typeof createFakeVoiceEngine>[0] = {}) {
  const engine: FakeVoiceEngine = createFakeVoiceEngine({ wordMs: 0, hearMs: 0, ...engineOptions });
  let listener: ((s: ChatSnapshot) => void) | null = null;
  let snap: ChatSnapshot = { isRunning: false, transcript: { messages: [], toolResults: {} }, question: null, otherRequest: false };
  const responses: Array<string | boolean> = [];
  const chat: VoiceChat = {
    watch: (fn) => ((listener = fn), fn(snap), () => (listener = null)),
    send: async () => ({ ok: true }),
    respond: (response) => {
      responses.push("value" in response ? response.value : "confirmed" in response ? response.confirmed : "cancelled");
      update({ question: null });
    },
    agentName: () => "Claude Code",
    sessionId: () => "s1",
  };
  const update = (next: Partial<ChatSnapshot>) =>
    act(() => {
      snap = { ...snap, ...next };
      listener?.(snap);
    });
  const conversation = new Conversation(engine, chat);
  const onClose = vi.fn(() => conversation.close());
  render(<VoiceView conversation={conversation} engine={engine} title="Fix login" onClose={onClose} />);
  return { engine, conversation, update, responses, onClose };
}

const tick = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const status = () => screen.getByRole("status").textContent;

function reply(text: string): ChatMessage[] {
  return [
    { id: "u", role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
    { id: "a", role: "assistant", content: [{ type: "text", text }], timestamp: 1, stopReason: "stop" },
  ];
}

describe("VoiceView", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("listening → live transcript → working → speaking with the current word highlighted → barge-in", async () => {
    const { engine, conversation, update } = setup();
    act(() => conversation.start());
    await tick();
    expect(screen.getByRole("dialog", { name: "Voice mode" }).dataset.look).toBe("listening");
    expect(status()).toBe("Listening");
    expect(screen.getByText("Fix login")).toBeTruthy();

    act(() => engine.emitListen({ type: "partial", text: "check the" }));
    expect(screen.getByTestId("voice-partial").textContent).toBe("check the");
    act(() => engine.emitListen({ type: "final", text: "check the build" }));
    expect(status()).toBe("Sending…");
    await tick();
    update({ isRunning: true });
    expect(status()).toBe("Working…");
    expect(screen.getByRole("dialog").dataset.look).toBe("thinking");

    update({ isRunning: false, transcript: { messages: reply("The build **passes**."), toolResults: {} } });
    expect(status()).toBe("Speaking");
    act(() => {
      engine.step();
      engine.step();
      engine.step();
    });
    const current = screen.getByTestId("voice-spoken").querySelector("[data-current]");
    expect(current?.textContent).toBe("passes.");
    expect((screen.getByRole("button", { name: "Stop speaking" }) as HTMLButtonElement).disabled).toBe(false);

    act(() => engine.emitListen({ type: "speech-start" }));
    expect(status()).toBe("Listening");
    expect(engine.speaking).toBeNull();
    // The reply stays readable, without a highlight.
    expect(screen.getByTestId("voice-spoken").textContent).toBe("The build passes.");
    expect(screen.getByTestId("voice-spoken").querySelector("[data-current]")).toBeNull();
  });

  it("the reply grows as it streams, read with the highlight moving on across pieces", async () => {
    const { engine, conversation, update } = setup();
    act(() => conversation.start());
    await tick();
    await act(() => engine.hear("status?"));
    await tick();
    const streaming = (text: string): ChatMessage[] => [
      { id: "u", role: "user", content: [{ type: "text", text: "status?" }], timestamp: 1 },
      { id: "a", role: "assistant", content: [{ type: "text", text }], timestamp: 1, streaming: true },
    ];
    update({ isRunning: true, transcript: { messages: streaming("All green"), toolResults: {} } });
    expect(status()).toBe("Working…");
    expect(screen.getByTestId("voice-tail").textContent).toBe("All green");
    update({ transcript: { messages: streaming("All green. Two warnings"), toolResults: {} } });
    expect(status()).toBe("Speaking");
    expect(screen.getByTestId("voice-spoken").textContent).toBe("All green. Two warnings");
    update({ transcript: { messages: streaming("All green. Two warnings left. Fixing"), toolResults: {} } });
    act(() => {
      engine.finishSpeaking();
      engine.step();
      engine.step();
    });
    const current = () => screen.getByTestId("voice-spoken").querySelector("[data-current]")?.textContent;
    expect(current()).toBe("warnings");
    expect(screen.getByTestId("voice-tail").textContent).toBe(" Fixing");
  });

  it("stop speaking and mute", async () => {
    const { engine, conversation, update } = setup();
    act(() => conversation.start());
    await tick();
    update({ isRunning: true });
    update({ isRunning: false, transcript: { messages: reply("Long answer"), toolResults: {} } });
    fireEvent.click(screen.getByRole("button", { name: "Stop speaking" }));
    expect(engine.speaking).toBeNull();
    expect(status()).toBe("Listening");
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(engine.listening).toBe(false);
    expect(status()).toBe("Muted");
    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
    expect(engine.listening).toBe(true);
  });

  it("a permission question with big answer buttons", async () => {
    const { engine, conversation, update, responses } = setup();
    act(() => conversation.start());
    await tick();
    update({ isRunning: true, question: { id: "q", kind: "permission", title: "Allow Bash?", message: "git push", options } });
    expect(status()).toBe("Permission needed");
    expect(screen.getByTestId("voice-spoken").textContent).toBe("Claude Code wants to use Bash: git push. Allow?");
    act(() => engine.finishSpeaking());
    expect(screen.getByText("Allow Bash?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Yes, and don't ask again for git" }));
    expect(responses).toEqual(["always"]);
    expect(status()).toBe("Working…");
    expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
  });

  it("a select question (I-193): spoken, numbered buttons, answered by number", async () => {
    const { engine, conversation, update, responses } = setup();
    act(() => conversation.start());
    await tick();
    update({ isRunning: true, question: { id: "s", kind: "select", title: "Which database?", options: ["PostgreSQL", "SQLite"] } });
    expect(status()).toBe("The agent asks");
    expect(screen.getByTestId("voice-spoken").textContent).toBe("Which database? The options are PostgreSQL or SQLite.");
    act(() => engine.finishSpeaking());
    expect(screen.getByRole("button", { name: "2. SQLite" })).toBeTruthy();
    await act(() => engine.hear("the second one"));
    expect(responses).toEqual(["SQLite"]);
  });

  it("a confirm question: Yes / No buttons", async () => {
    const { engine, conversation, update, responses } = setup();
    act(() => conversation.start());
    await tick();
    update({ isRunning: true, question: { id: "c", kind: "confirm", title: "Delete the branch?" } });
    act(() => engine.finishSpeaking());
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(responses).toEqual([false]);
  });

  it("answering a permission by voice", async () => {
    const { engine, conversation, update, responses } = setup();
    act(() => conversation.start());
    await tick();
    update({ isRunning: true, question: { id: "q", kind: "permission", title: "Allow Bash?", options } });
    await act(() => engine.hear("yes please"));
    expect(responses).toEqual(["allow"]);
  });

  it("denied permissions: a sheet explains how to allow them", async () => {
    const { conversation, onClose } = setup({ permissions: { microphone: "denied", speechRecognition: "granted" } });
    act(() => conversation.start());
    await tick();
    expect(screen.getByRole("dialog", { name: "Allow Voice" }).textContent).toContain("Settings → Apps → Glade");
    fireEvent.click(screen.getByRole("button", { name: "Back to Chat" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("speech unavailable: explains it", async () => {
    const { conversation } = setup({ available: false });
    act(() => conversation.start());
    await tick();
    expect(screen.getByRole("dialog", { name: "Voice Unavailable" })).toBeTruthy();
  });

  it("the fake engine's Say field stands in for the microphone", async () => {
    const { conversation } = setup();
    act(() => conversation.start());
    await tick();
    fireEvent.input(screen.getByLabelText("Say (debug)"), { target: { value: "hello there" } });
    fireEvent.submit(screen.getByLabelText("Say (debug)").closest("form")!);
    await tick();
    expect(conversation.state.value.heard).toBe("hello there");
  });

  it("close ends the voice session", async () => {
    const { engine, conversation, onClose } = setup();
    act(() => conversation.start());
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "Close voice mode" }));
    await tick();
    expect(onClose).toHaveBeenCalled();
    expect(engine.sessionActive).toBe(false);
  });
});
