/**
 * Conversation mode's state machine (I-180), pure: `step(state, event)` → the next state and the
 * effects to run (speak, listen, send, cues…). `conversation.ts` feeds it engine and chat events
 * and runs the effects.
 *
 *   starting → listening ──final──▶ sending ──run starts──▶ working (cue "working", then a
 *   "working-tick" every few seconds) ──run ends──▶ speaking the reply ──done──▶ listening …
 *
 * The mic stays on the whole time (unless muted): talking over a reply stops it at once
 * (barge-in, `speech-start`) and listens; talking while the agent works sends the words like the
 * composer's Send (steer, or queued where the agent can't steer). A permission card is read out
 * ("… Allow?") and answered by voice (answers.ts); "no" picks the rejection and asks what to do
 * instead, and the next utterance is sent. An unclear answer is asked again once, then the
 * question stays on screen (with buttons).
 */
import type { CueName } from "./engine";
import type { PermissionRequest } from "./answers";
import { matchPermissionAnswer, permissionRetryQuestion } from "./answers";
import { plainSpeakable, type Speakable } from "./speakable";

export type AskStep =
  /** Reading the question. */
  | "question"
  /** Waiting for yes / yes always / no. */
  | "answer"
  /** Rejected: waiting for what to do instead (sent as the next message). */
  | "instead"
  /** Asked twice without a clear answer: on screen only (buttons; a clear spoken answer still works). */
  | "screen";

export type Phase =
  | { name: "starting" }
  /** Speech isn't possible: `denied` (mic or speech recognition not allowed) or `unsupported`. */
  | { name: "unavailable"; reason: "denied" | "unsupported" }
  | { name: "listening" }
  | { name: "sending"; text: string }
  | { name: "working" }
  | { name: "speaking"; speech: Speakable; word: [number, number] | null }
  | { name: "asking"; request: PermissionRequest; step: AskStep; retried: boolean; speech: Speakable | null; word: [number, number] | null }
  | { name: "error"; message: string; retry: "send" | "listen" | "start"; text?: string }
  | { name: "closed" };

export interface VoiceState {
  phase: Phase;
  /** The live transcript of what the user is saying. */
  partial: string;
  /** The last thing the user said (sent or answered). */
  heard: string;
  muted: boolean;
  /** The agent is running (from the chat). */
  running: boolean;
  /** A passing notice (e.g. a recoverable recognition hiccup). */
  notice: string | null;
}

export type VoiceEvent =
  | { type: "started"; running: boolean }
  | { type: "unavailable"; reason: "denied" | "unsupported" }
  | { type: "start-failed"; message: string }
  | { type: "speech-start" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "listen-error"; message: string; recoverable: boolean }
  | { type: "sent" }
  | { type: "send-failed"; message: string; text: string }
  | { type: "run-start" }
  | { type: "run-end"; reply: Speakable | null }
  | { type: "permission"; request: PermissionRequest; question: string }
  | { type: "permission-gone"; requestId: string }
  | { type: "word"; start: number; end: number }
  | { type: "speak-done" }
  | { type: "speak-cancelled" }
  | { type: "speak-error"; message: string }
  | { type: "tick" }
  | { type: "mute"; muted: boolean }
  | { type: "stop-speaking" }
  /** An answer button on screen. */
  | { type: "answer"; optionId: string }
  | { type: "retry" }
  | { type: "close" };

export type VoiceEffect =
  | { type: "start" }
  | { type: "listen" }
  | { type: "stop-listening" }
  | { type: "speak"; speech: Speakable }
  | { type: "stop-speaking" }
  | { type: "cue"; cue: CueName }
  | { type: "send"; text: string }
  | { type: "respond"; requestId: string; optionId: string }
  /** Start or stop the "still working" ticker (a `tick` event every few seconds). */
  | { type: "ticker"; on: boolean }
  | { type: "end-session" };

export interface StepResult {
  state: VoiceState;
  effects: VoiceEffect[];
}

export const INSTEAD_QUESTION = "OK. What should I do instead?";
export const SCREEN_NOTICE = "I'll leave the question on screen.";

export function initialVoiceState(): VoiceState {
  return { phase: { name: "starting" }, partial: "", heard: "", muted: false, running: false, notice: null };
}

/** Where to go when nothing else is happening. */
function rest(state: VoiceState, effects: VoiceEffect[]): Phase {
  if (state.running) {
    effects.push({ type: "ticker", on: true });
    return { name: "working" };
  }
  return { name: "listening" };
}

function isSpeaking(phase: Phase): boolean {
  return phase.name === "speaking" || (phase.name === "asking" && !!phase.speech);
}

export function step(state: VoiceState, event: VoiceEvent): StepResult {
  const effects: VoiceEffect[] = [];
  const phase = state.phase;
  const done = (next: Partial<VoiceState>): StepResult => ({ state: { ...state, ...next }, effects });
  if (phase.name === "closed") return { state, effects };

  switch (event.type) {
    case "close":
      effects.push({ type: "ticker", on: false }, { type: "stop-speaking" }, { type: "stop-listening" }, { type: "end-session" });
      return done({ phase: { name: "closed" }, partial: "" });

    case "started": {
      const next = { ...state, running: event.running };
      if (!state.muted) effects.push({ type: "listen" });
      effects.push({ type: "cue", cue: "listening" });
      return done({ running: event.running, phase: rest(next, effects), notice: null });
    }
    case "unavailable":
      return done({ phase: { name: "unavailable", reason: event.reason } });
    case "start-failed":
      effects.push({ type: "cue", cue: "error" });
      return done({ phase: { name: "error", message: event.message, retry: "start" } });
  }

  if (phase.name === "starting" || phase.name === "unavailable") {
    // Chat state can change before the session is up; remember whether the agent runs.
    if (event.type === "run-start") return done({ running: true });
    if (event.type === "run-end") return done({ running: false });
    if (event.type === "retry" && phase.name === "unavailable") {
      effects.push({ type: "start" });
      return done({ phase: { name: "starting" } });
    }
    return { state, effects };
  }

  switch (event.type) {
    case "partial":
      return done({ partial: event.text, notice: null });

    case "speech-start":
      // Barge-in: stop talking at once and listen.
      if (phase.name === "speaking") {
        effects.push({ type: "stop-speaking" });
        return done({ phase: rest(state, effects) });
      }
      if (phase.name === "asking" && phase.speech) {
        effects.push({ type: "stop-speaking" });
        return done({ phase: { ...phase, step: phase.step === "question" ? "answer" : phase.step, speech: null, word: null } });
      }
      return { state, effects };

    case "final": {
      const text = event.text.trim();
      if (!text) return done({ partial: "" });
      if (isSpeaking(phase)) effects.push({ type: "stop-speaking" });
      if (phase.name === "asking" && phase.step !== "instead") {
        const option = matchPermissionAnswer(text, phase.request.options);
        if (option) return answered(state, phase, option.id, text, effects);
        if (!phase.retried) {
          const speech = plainSpeakable(permissionRetryQuestion(phase.request.options));
          effects.push({ type: "speak", speech });
          return done({ partial: "", heard: text, phase: { ...phase, step: "question", retried: true, speech, word: null } });
        }
        const speech = plainSpeakable(SCREEN_NOTICE);
        effects.push({ type: "speak", speech });
        return done({ partial: "", heard: text, phase: { ...phase, step: "screen", speech, word: null } });
      }
      // Sent like the composer's Send (while the agent works: steer or queue).
      effects.push({ type: "ticker", on: false }, { type: "cue", cue: "sent" }, { type: "send", text });
      return done({ partial: "", heard: text, phase: { name: "sending", text } });
    }

    case "listen-error":
      if (event.recoverable) return done({ notice: event.message });
      effects.push({ type: "ticker", on: false }, { type: "cue", cue: "error" });
      return done({ partial: "", phase: { name: "error", message: event.message, retry: "listen" } });

    case "sent":
      if (phase.name !== "sending") return { state, effects };
      if (!state.running) return { state, effects };
      effects.push({ type: "ticker", on: true });
      return done({ phase: { name: "working" } });

    case "send-failed":
      effects.push({ type: "cue", cue: "error" });
      return done({ phase: { name: "error", message: event.message, retry: "send", text: event.text } });

    case "run-start":
      if (phase.name === "listening" || phase.name === "sending") {
        effects.push({ type: "cue", cue: "working" }, { type: "ticker", on: true });
        return done({ running: true, phase: { name: "working" } });
      }
      return done({ running: true });

    case "run-end": {
      effects.push({ type: "ticker", on: false });
      const next = { ...state, running: false };
      const idle = phase.name === "working" || phase.name === "sending" || (phase.name === "listening" && !state.partial);
      if (!idle) {
        // Still asking (e.g. the run was stopped): the question goes away with its request.
        return done({ running: false });
      }
      if (!event.reply) {
        effects.push({ type: "cue", cue: "done" });
        return done({ running: false, phase: rest(next, effects) });
      }
      effects.push({ type: "speak", speech: event.reply });
      return done({ running: false, phase: { name: "speaking", speech: event.reply, word: null } });
    }

    case "permission": {
      if (isSpeaking(phase)) effects.push({ type: "stop-speaking" });
      const speech = plainSpeakable(event.question);
      effects.push({ type: "ticker", on: false }, { type: "speak", speech });
      return done({ partial: "", phase: { name: "asking", request: event.request, step: "question", retried: false, speech, word: null } });
    }

    case "permission-gone":
      if (phase.name !== "asking" || phase.request.id !== event.requestId || phase.step === "instead") return { state, effects };
      if (phase.speech) effects.push({ type: "stop-speaking" });
      return done({ phase: rest(state, effects) });

    case "word":
      if (phase.name === "speaking" || (phase.name === "asking" && phase.speech)) return done({ phase: { ...phase, word: [event.start, event.end] } });
      return { state, effects };

    case "speak-done":
    case "speak-error":
    case "speak-cancelled":
      if (phase.name === "speaking") return done({ phase: rest(state, effects) });
      if (phase.name === "asking" && phase.speech) {
        return done({ phase: { ...phase, step: phase.step === "question" ? "answer" : phase.step, speech: null, word: null } });
      }
      return { state, effects };

    case "tick":
      if (phase.name === "working") effects.push({ type: "cue", cue: "working-tick" });
      return { state, effects };

    case "mute":
      if (event.muted === state.muted) return { state, effects };
      effects.push({ type: event.muted ? "stop-listening" : "listen" });
      return done({ muted: event.muted, partial: "" });

    case "stop-speaking":
      if (phase.name === "speaking") {
        effects.push({ type: "stop-speaking" });
        return done({ phase: rest(state, effects) });
      }
      if (phase.name === "asking" && phase.speech) {
        effects.push({ type: "stop-speaking" });
        return done({ phase: { ...phase, step: phase.step === "question" ? "answer" : phase.step, speech: null, word: null } });
      }
      return { state, effects };

    case "answer":
      if (phase.name !== "asking" || phase.step === "instead") return { state, effects };
      if (phase.speech) effects.push({ type: "stop-speaking" });
      return answered(state, phase, event.optionId, state.heard, effects);

    case "retry":
      if (phase.name !== "error") return { state, effects };
      if (phase.retry === "send" && phase.text) {
        effects.push({ type: "cue", cue: "sent" }, { type: "send", text: phase.text });
        return done({ phase: { name: "sending", text: phase.text } });
      }
      if (phase.retry === "start") {
        effects.push({ type: "start" });
        return done({ phase: { name: "starting" } });
      }
      if (!state.muted) effects.push({ type: "listen" });
      effects.push({ type: "cue", cue: "listening" });
      return done({ phase: rest(state, effects) });
  }
  return { state, effects };
}

function answered(state: VoiceState, phase: Phase & { name: "asking" }, optionId: string, heard: string, effects: VoiceEffect[]): StepResult {
  const option = phase.request.options.find((o) => o.id === optionId);
  effects.push({ type: "respond", requestId: phase.request.id, optionId });
  if (option?.kind.startsWith("reject") && option.focusComposer) {
    // "No, and tell … what to do differently": the next utterance is the new instruction.
    const speech = plainSpeakable(INSTEAD_QUESTION);
    effects.push({ type: "speak", speech });
    return { state: { ...state, partial: "", heard, phase: { ...phase, step: "instead", speech, word: null } }, effects };
  }
  return { state: { ...state, partial: "", heard, phase: rest(state, effects) }, effects };
}
