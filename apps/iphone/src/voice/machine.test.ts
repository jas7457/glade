import { describe, expect, it } from "vitest";
import type { PermissionOption } from "@glade/protocol";
import type { PermissionRequest } from "./answers";
import { INSTEAD_QUESTION, SCREEN_NOTICE, initialVoiceState, step, type VoiceEffect, type VoiceEvent, type VoiceState } from "./machine";
import type { ReplyPiece, TurnPlan } from "./reply-stream";
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
/** A reply plan: its final pieces (keyed by their text) and the tail. */
function plan(pieces: string[], tail: string | null = null, turn = "u1"): TurnPlan {
  const piece = (t: string): ReplyPiece => ({ key: t, sep: " ", speech: plainSpeakable(t) });
  return { turn, pieces: pieces.map(piece), tail: tail ? piece(tail) : null };
}
const reply: VoiceEvent = { type: "reply", plan: plan(["Done."]) };
const speaks = (effects: VoiceEffect[]) => effects.flatMap((e) => (e.type === "speak" ? [{ text: e.speech.text, queue: !!e.queue, offset: e.offset ?? 0 }] : []));
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

    r = run([reply, { type: "run-end" }], r.state);
    expect(r.state.phase).toEqual({ name: "speaking" });
    expect(speaks(r.effects)).toEqual([{ text: "Done.", queue: false, offset: 0 }]);
    expect(types(r.effects)).toContain("ticker:false");

    r = run([{ type: "word", start: 0, end: 5 }], r.state);
    expect(r.state.reading).toMatchObject({ word: [0, 5] });
    r = run([{ type: "speak-done" }], r.state);
    expect(r.state.phase.name).toBe("listening");
    expect(types(r.effects)).not.toContain("cue:done");
  });

  it("a run that ends without a reply plays the done cue", () => {
    const r = run([{ type: "final", text: "hi" }, { type: "run-start" }, { type: "run-end" }], started);
    expect(r.state.phase.name).toBe("listening");
    expect(types(r.effects)).toContain("cue:done");
  });

  it("sent before the run starts waits in sending", () => {
    const r = run([{ type: "final", text: "hi" }, { type: "sent" }], started);
    expect(r.state.phase.name).toBe("sending");
  });

  it("barge-in: speech while speaking stops at once and listens", () => {
    const speaking = run([{ type: "final", text: "hi" }, { type: "run-start" }, reply, { type: "run-end" }], started).state;
    const r = run([{ type: "speech-start" }], speaking);
    expect(r.state.phase.name).toBe("listening");
    expect(types(r.effects)).toEqual(["stop-speaking"]);
    // The cancelled event that follows changes nothing.
    expect(run([{ type: "speak-cancelled" }], r.state).state.phase.name).toBe("listening");
    // What was said is sent.
    expect(run([{ type: "final", text: "wait, stop" }], r.state).effects).toContainEqual({ type: "send", text: "wait, stop" });
  });

  it("the stop button stops speaking", () => {
    const speaking = run([{ type: "run-start" }, reply, { type: "run-end" }], started).state;
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
      r = run([reply, { type: "run-end" }, { type: "speak-done" }, { type: "permission-gone", requestId: "q1" }], r.state);
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
      const speaking = run([reply, { type: "run-end" }], asking.state).state;
      expect(speaking.phase.name).toBe("asking");
      const reading = run([{ type: "run-start" }, { type: "reply", plan: plan(["One.", "Two."]) }], started).state;
      let r = run([{ type: "permission", request, question: "Allow?" }], reading);
      expect(types(r.effects)[0]).toBe("stop-speaking");
      // What was queued is skipped; what the agent writes after the answer is read.
      r = run([{ type: "speak-done" }, { type: "final", text: "yes" }, { type: "permission-gone", requestId: "q1" }], r.state);
      expect(r.state.phase.name).toBe("working");
      r = run([{ type: "reply", plan: plan(["One.", "Two.", "Three."]) }], r.state);
      expect(speaks(r.effects)).toEqual([{ text: "Three.", queue: false, offset: 10 }]);
    });
  });

  describe("reading a reply while it streams (I-183)", () => {
    const working = run([{ type: "final", text: "hi" }, { type: "sent" }, { type: "run-start" }], started).state;

    it("reads final pieces as they come, queued, with words in the whole reply's offsets", () => {
      let r = run([{ type: "reply", plan: plan([], "The bu") }], working);
      expect(r.state.phase.name).toBe("working");
      expect(r.state.reading).toMatchObject({ tail: { speech: { text: "The bu" } }, shown: true });
      expect(speaks(r.effects)).toEqual([]);

      r = run([{ type: "reply", plan: plan(["The build passes."], "All forty") }], r.state);
      expect(r.state.phase.name).toBe("speaking");
      expect(types(r.effects)).toEqual(["speak", "ticker:false"]);
      expect(speaks(r.effects)).toEqual([{ text: "The build passes.", queue: false, offset: 0 }]);

      r = run([{ type: "reply", plan: plan(["The build passes.", "All forty tests ran.", "Nice."], "Mo") }], r.state);
      expect(speaks(r.effects)).toEqual([{ text: "All forty tests ran. Nice.", queue: true, offset: 18 }]);
      expect(r.state.reading).toMatchObject({ pending: 2, speech: { text: "The build passes. All forty tests ran. Nice." } });

      r = run([{ type: "word", start: 22, end: 27 }], r.state);
      expect(r.state.reading!.word).toEqual([22, 27]);
      // The first piece is done: still speaking the next one.
      r = run([{ type: "speak-done" }], r.state);
      expect(r.state.phase.name).toBe("speaking");
      // The queue ran dry while the agent writes on: working (ticks) again, no "working" cue.
      r = run([{ type: "speak-done" }], r.state);
      expect(r.state.phase.name).toBe("working");
      expect(types(r.effects)).toEqual(["ticker:true"]);
      expect(r.state.reading!.word).toBeNull();

      // The end: the last sentence is read, then it listens.
      r = run([{ type: "reply", plan: plan(["The build passes.", "All forty tests ran.", "Nice.", "More soon."]) }, { type: "run-end" }], r.state);
      expect(r.state.phase.name).toBe("speaking");
      expect(speaks(r.effects)).toEqual([{ text: "More soon.", queue: false, offset: 45 }]);
      r = run([{ type: "speak-done" }], r.state);
      expect(r.state.phase.name).toBe("listening");
      expect(types(r.effects)).toEqual([]);
    });

    it("barge-in stops the rest of this reply; the next turn is read again", () => {
      let r = run([{ type: "reply", plan: plan(["One."]) }, { type: "speech-start" }], working);
      expect(r.state.phase.name).toBe("working");
      expect(r.state.reading).toMatchObject({ silenced: true, shown: true });
      r = run([{ type: "reply", plan: plan(["One.", "Two."]) }], r.state);
      expect(speaks(r.effects)).toEqual([]);
      expect(r.state.reading!.speech.text).toBe("One. Two.");
      // The user said something: sent, the old reply is hidden.
      r = run([{ type: "final", text: "stop that" }], r.state);
      expect(r.state.reading).toMatchObject({ silenced: true, shown: false });
      r = run([{ type: "sent" }, { type: "reply", plan: plan(["OK, stopping."], null, "u2") }], r.state);
      expect(speaks(r.effects)).toEqual([{ text: "OK, stopping.", queue: false, offset: 0 }]);
    });

    it("talking while it streams (not speaking) stops reading it", () => {
      let r = run([{ type: "partial", text: "also" }, { type: "reply", plan: plan(["One."]) }], working);
      // Not over the user's words.
      expect(speaks(r.effects)).toEqual([]);
      r = run([{ type: "final", text: "also the docs" }, { type: "reply", plan: plan(["One.", "Two."]) }], r.state);
      expect(speaks(r.effects)).toEqual([]);
      // A cough (no words) reads what waited.
      r = run([{ type: "partial", text: "hm" }, { type: "reply", plan: plan(["A.", "B."], null, "u9") }], working);
      expect(speaks(r.effects)).toEqual([]);
      r = run([{ type: "final", text: "" }], r.state);
      expect(speaks(r.effects)).toEqual([{ text: "A. B.", queue: false, offset: 0 }]);
    });

    it("a reply that was there before voice mode opened is neither read nor shown", () => {
      let r = run([{ type: "reply", plan: plan(["Old."]), silent: true }, { type: "started", running: false }]);
      expect(speaks(r.effects)).toEqual([]);
      expect(r.state.reading).toMatchObject({ silenced: true, shown: false });
      r = run([{ type: "reply", plan: plan(["New."], null, "u2") }], r.state);
      expect(speaks(r.effects)).toEqual([{ text: "New.", queue: false, offset: 0 }]);
    });

    it("a reply noted while starting is read once started (the agent was already running)", () => {
      const r = run([{ type: "run-start" }, { type: "reply", plan: plan(["So far."]) }, { type: "started", running: true }]);
      expect(r.state.phase.name).toBe("speaking");
      expect(speaks(r.effects)).toEqual([{ text: "So far.", queue: false, offset: 0 }]);
    });

    it("an interrupted piece ends the reading", () => {
      let r = run([{ type: "reply", plan: plan(["One."]) }, { type: "reply", plan: plan(["One.", "Two."]) }], working);
      r = run([{ type: "speak-error", message: "Audio was interrupted." }], r.state);
      expect(r.state.phase.name).toBe("working");
      expect(types(r.effects)).toContain("stop-speaking");
      expect(r.state.reading!.silenced).toBe(true);
    });
  });
});
