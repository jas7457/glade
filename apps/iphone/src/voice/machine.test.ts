import { describe, expect, it } from "vitest";
import type { PermissionOption } from "@glade/protocol";
import type { PermissionRequest } from "./answers";
import { INSTEAD_QUESTION, SCREEN_NOTICE, initialVoiceState, step, type VoiceEffect, type VoiceEvent, type VoiceState } from "./machine";
import { plainSpeakable } from "./speakable";

/** Runs events from a state; returns the final state and every effect. */
function run(events: VoiceEvent[], from: VoiceState = initialVoiceState()) {
  let state = from;
  const effects: VoiceEffect[] = [];
  for (const e of events) {
    const r = step(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}

const started = run([{ type: "started", running: false }]).state;
const options: PermissionOption[] = [
  { id: "allow", label: "Yes", kind: "allow_once" },
  { id: "always", label: "Yes, and don't ask again for git commands", kind: "allow_always" },
  { id: "reject", label: "No, and tell Claude what to do differently", kind: "reject_once", focusComposer: true },
];
const request: PermissionRequest = { id: "q1", kind: "permission", title: "Allow Bash?", options };
const reply = plainSpeakable("Done.");
const types = (effects: VoiceEffect[]) => effects.map((e) => (e.type === "cue" ? `cue:${e.cue}` : e.type === "ticker" ? `ticker:${e.on}` : e.type));

describe("conversation state machine", () => {
  it("starts listening", () => {
    const { state, effects } = run([{ type: "started", running: false }]);
    expect(state.phase.name).toBe("listening");
    expect(types(effects)).toEqual(["listen", "cue:listening"]);
  });

  it("starts out working when the agent already runs", () => {
    const { state, effects } = run([{ type: "started", running: true }]);
    expect(state.phase.name).toBe("working");
    expect(types(effects)).toContain("ticker:true");
  });

  it("listening → sending → working (cue, ticks) → speaking → listening", () => {
    let r = run([{ type: "partial", text: "run the" }], started);
    expect(r.state.partial).toBe("run the");
    r = run([{ type: "final", text: "run the tests" }], r.state);
    expect(r.state.phase).toEqual({ name: "sending", text: "run the tests" });
    expect(r.state.partial).toBe("");
    expect(r.effects).toContainEqual({ type: "send", text: "run the tests" });
    expect(types(r.effects)).toContain("cue:sent");

    r = run([{ type: "sent" }, { type: "run-start" }], r.state);
    expect(r.state.phase.name).toBe("working");
    expect(types(r.effects)).toEqual(["cue:working", "ticker:true"]);
    expect(types(run([{ type: "tick" }], r.state).effects)).toEqual(["cue:working-tick"]);

    r = run([{ type: "run-end", reply }], r.state);
    expect(r.state.phase).toEqual({ name: "speaking", speech: reply, word: null });
    expect(r.effects).toContainEqual({ type: "speak", speech: reply });
    expect(types(r.effects)).toContain("ticker:false");

    r = run([{ type: "word", start: 0, end: 5 }], r.state);
    expect(r.state.phase).toMatchObject({ name: "speaking", word: [0, 5] });
    r = run([{ type: "speak-done" }], r.state);
    expect(r.state.phase.name).toBe("listening");
  });

  it("a run that ends without a reply plays the done cue", () => {
    const r = run([{ type: "final", text: "hi" }, { type: "run-start" }, { type: "run-end", reply: null }], started);
    expect(r.state.phase.name).toBe("listening");
    expect(types(r.effects)).toContain("cue:done");
  });

  it("sent before the run starts waits in sending", () => {
    const r = run([{ type: "final", text: "hi" }, { type: "sent" }], started);
    expect(r.state.phase.name).toBe("sending");
  });

  it("barge-in: speech while speaking stops at once and listens", () => {
    const speaking = run([{ type: "final", text: "hi" }, { type: "run-start" }, { type: "run-end", reply }], started).state;
    const r = run([{ type: "speech-start" }], speaking);
    expect(r.state.phase.name).toBe("listening");
    expect(types(r.effects)).toEqual(["stop-speaking"]);
    // The cancelled event that follows changes nothing.
    expect(run([{ type: "speak-cancelled" }], r.state).state.phase.name).toBe("listening");
    // What was said is sent.
    expect(run([{ type: "final", text: "wait, stop" }], r.state).effects).toContainEqual({ type: "send", text: "wait, stop" });
  });

  it("the stop button stops speaking", () => {
    const speaking = run([{ type: "run-start" }, { type: "run-end", reply }], started).state;
    const r = run([{ type: "stop-speaking" }], speaking);
    expect(r.state.phase.name).toBe("listening");
    expect(types(r.effects)).toEqual(["stop-speaking"]);
  });

  it("talking while the agent works sends it (steer/queue) and keeps working", () => {
    const working = run([{ type: "run-start" }], started).state;
    let r = run([{ type: "final", text: "also update the docs" }], working);
    expect(r.effects).toContainEqual({ type: "send", text: "also update the docs" });
    expect(types(r.effects)).toContain("ticker:false");
    r = run([{ type: "sent" }], r.state);
    expect(r.state.phase.name).toBe("working");
    expect(types(r.effects)).toEqual(["ticker:true"]);
  });

  it("send failure → error with retry", () => {
    let r = run([{ type: "final", text: "hi" }, { type: "send-failed", message: "offline", text: "hi" }], started);
    expect(r.state.phase).toEqual({ name: "error", message: "offline", retry: "send", text: "hi" });
    expect(types(r.effects)).toContain("cue:error");
    r = run([{ type: "retry" }], r.state);
    expect(r.state.phase.name).toBe("sending");
    expect(r.effects).toContainEqual({ type: "send", text: "hi" });
  });

  it("recognition errors: recoverable = notice, else error + retry listens again", () => {
    expect(run([{ type: "listen-error", message: "route changed", recoverable: true }], started).state).toMatchObject({ phase: { name: "listening" }, notice: "route changed" });
    let r = run([{ type: "listen-error", message: "interrupted", recoverable: false }], started);
    expect(r.state.phase).toMatchObject({ name: "error", retry: "listen" });
    r = run([{ type: "retry" }], r.state);
    expect(r.state.phase.name).toBe("listening");
    expect(types(r.effects)).toEqual(["listen", "cue:listening"]);
  });

  it("mute stops listening; unmute listens again", () => {
    let r = run([{ type: "mute", muted: true }], started);
    expect(r.state.muted).toBe(true);
    expect(types(r.effects)).toEqual(["stop-listening"]);
    r = run([{ type: "mute", muted: false }], r.state);
    expect(types(r.effects)).toEqual(["listen"]);
  });

  it("unavailable, then retry starts again", () => {
    let r = run([{ type: "unavailable", reason: "denied" }]);
    expect(r.state.phase).toEqual({ name: "unavailable", reason: "denied" });
    r = run([{ type: "retry" }], r.state);
    expect(r.state.phase.name).toBe("starting");
    expect(types(r.effects)).toEqual(["start"]);
  });

  it("close ends everything", () => {
    const working = run([{ type: "run-start" }], started).state;
    const r = run([{ type: "close" }], working);
    expect(r.state.phase.name).toBe("closed");
    expect(types(r.effects)).toEqual(["ticker:false", "stop-speaking", "stop-listening", "end-session"]);
    expect(run([{ type: "final", text: "hi" }], r.state).effects).toEqual([]);
  });

  describe("permission by voice", () => {
    const asking = run([{ type: "run-start" }, { type: "permission", request, question: "Claude wants to use Bash. Allow?" }], started);

    it("reads the question, then waits for the answer", () => {
      expect(asking.state.phase).toMatchObject({ name: "asking", step: "question" });
      expect(asking.effects).toContainEqual({ type: "speak", speech: plainSpeakable("Claude wants to use Bash. Allow?") });
      expect(types(asking.effects)).toContain("ticker:false");
      expect(run([{ type: "speak-done" }], asking.state).state.phase).toMatchObject({ step: "answer", speech: null });
    });

    it("yes → allow, back to working", () => {
      const r = run([{ type: "speak-done" }, { type: "final", text: "yes" }], asking.state);
      expect(r.effects).toContainEqual({ type: "respond", requestId: "q1", optionId: "allow" });
      expect(r.state.phase.name).toBe("working");
    });

    it("answering over the question stops reading it", () => {
      const r = run([{ type: "speech-start" }, { type: "final", text: "yes always" }], asking.state);
      expect(types(r.effects)[0]).toBe("stop-speaking");
      expect(r.effects).toContainEqual({ type: "respond", requestId: "q1", optionId: "always" });
    });

    it("no → reject, asks what to do instead, then sends that", () => {
      let r = run([{ type: "speak-done" }, { type: "final", text: "no" }], asking.state);
      expect(r.effects).toContainEqual({ type: "respond", requestId: "q1", optionId: "reject" });
      expect(r.effects).toContainEqual({ type: "speak", speech: plainSpeakable(INSTEAD_QUESTION) });
      expect(r.state.phase).toMatchObject({ name: "asking", step: "instead" });
      // The stopped run ends meanwhile: still waiting.
      r = run([{ type: "run-end", reply }, { type: "speak-done" }, { type: "permission-gone", requestId: "q1" }], r.state);
      expect(r.state.phase).toMatchObject({ name: "asking", step: "instead" });
      r = run([{ type: "final", text: "use yarn instead" }], r.state);
      expect(r.effects).toContainEqual({ type: "send", text: "use yarn instead" });
      expect(r.state.phase.name).toBe("sending");
    });

    it("unclear → asks again once, then leaves it on screen", () => {
      let r = run([{ type: "speak-done" }, { type: "final", text: "what was that" }], asking.state);
      expect(r.state.phase).toMatchObject({ step: "question", retried: true });
      expect(r.effects.some((e) => e.type === "speak")).toBe(true);
      expect(r.effects.some((e) => e.type === "respond")).toBe(false);
      r = run([{ type: "speak-done" }, { type: "final", text: "banana" }], r.state);
      expect(r.effects).toContainEqual({ type: "speak", speech: plainSpeakable(SCREEN_NOTICE) });
      expect(r.state.phase).toMatchObject({ step: "screen" });
      // A button still answers.
      r = run([{ type: "speak-done" }, { type: "answer", optionId: "allow" }], r.state);
      expect(r.effects).toContainEqual({ type: "respond", requestId: "q1", optionId: "allow" });
      expect(r.state.phase.name).toBe("working");
    });

    it("answered elsewhere (on the Mac) → back to working", () => {
      const r = run([{ type: "permission-gone", requestId: "q1" }], asking.state);
      expect(r.state.phase.name).toBe("working");
      expect(types(r.effects)).toEqual(["stop-speaking", "ticker:true"]);
    });

    it("a question interrupts a reply being read", () => {
      const speaking = run([{ type: "run-end", reply }], asking.state).state;
      expect(speaking.phase.name).toBe("asking");
      const reading = run([{ type: "run-start" }, { type: "run-end", reply }], started).state;
      const r = run([{ type: "permission", request, question: "Allow?" }], reading);
      expect(types(r.effects)[0]).toBe("stop-speaking");
    });
  });
});
