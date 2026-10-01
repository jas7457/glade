import { afterEach, describe, expect, it } from "vitest";
import type { Transcript } from "@glade/protocol";
import { readingHighlight } from "@glade/app-core/state/reading-highlight";
import { chatHighlightOf } from "./chat-highlight";
import { initialVoiceState, step, type VoiceEvent, type VoiceState } from "./machine";
import { planTurn } from "./reply-stream";
import { setVoiceEngine } from "./engine-provider";
import { createFakeVoiceEngine } from "./fake-engine";
import { closeVoiceMode, minimizeVoiceMode, openVoiceMode, restoreVoiceMode, voiceMode } from "./voice-mode";

const transcript: Transcript = {
  messages: [
    { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "text", text: "Run **the tests** first." },
        { type: "toolCall", id: "t", name: "bash", kind: "shell", input: {}, args: {} },
        { type: "text", text: "All `green` now." },
      ],
      timestamp: 0,
    },
  ],
  toolResults: {},
};

function run(events: VoiceEvent[], state: VoiceState = initialVoiceState()): VoiceState {
  for (const e of events) state = step(state, e).state;
  return state;
}

describe("the word being read, in the chat (I-193)", () => {
  const reading = run([{ type: "started", running: true }, { type: "reply", plan: planTurn(transcript, true) }]);
  const text = reading.reading!.speech.text;
  const word = (w: string): VoiceEvent => ({ type: "word", start: text.indexOf(w), end: text.indexOf(w) + w.length });

  it("maps the spoken word to its message, block and markdown range", () => {
    expect(text).toBe("Run the tests first.\nRunning a command.\nAll green now.");
    expect(chatHighlightOf(run([word("tests")], reading))).toEqual({ messageId: "a1", block: 0, range: [10, 15] });
    expect(chatHighlightOf(run([word("green")], reading))).toEqual({ messageId: "a1", block: 2, range: [5, 10] });
  });

  it("nothing for announcements, or once reading stops", () => {
    expect(chatHighlightOf(run([word("command")], reading))).toBeNull();
    expect(chatHighlightOf(run([word("tests"), { type: "stop-speaking" }], reading))).toBeNull();
  });
});

describe("minimized voice mode (I-193)", () => {
  afterEach(() => {
    closeVoiceMode();
    setVoiceEngine(null);
  });

  it("minimizes and comes back; the voice button of that chat restores it; closing clears the highlight", () => {
    setVoiceEngine(createFakeVoiceEngine({ wordMs: 0 }));
    openVoiceMode({ kind: "chat", sessionId: "s1" });
    const conversation = voiceMode.value!.conversation;
    minimizeVoiceMode();
    expect(voiceMode.value).toMatchObject({ minimized: true });
    openVoiceMode({ kind: "chat", sessionId: "s1" });
    expect(voiceMode.value).toMatchObject({ minimized: false });
    expect(voiceMode.value!.conversation).toBe(conversation);
    minimizeVoiceMode();
    restoreVoiceMode();
    expect(voiceMode.value?.minimized).toBe(false);
    readingHighlight.value = { messageId: "a1", block: 0, range: [0, 3] };
    closeVoiceMode();
    expect(voiceMode.value).toBeNull();
    expect(readingHighlight.value).toBeNull();
    expect(conversation.state.value.phase.name).toBe("closed");
  });
});
