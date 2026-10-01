/**
 * Conversation mode's state machine (I-180), pure: `step(state, event)` → the next state and the
 * effects to run (speak, listen, send, cues…). `conversation.ts` feeds it engine and chat events
 * and runs the effects.
 *
 *   starting → listening ──final──▶ sending ──run starts──▶ working (cue "working", then a
 *   "working-tick" every few seconds) ──a sentence is final──▶ speaking ⇄ working … ──run ends,
 *   the rest read──▶ listening …
 *
 * The reply is read while it streams (I-183): every chat snapshot's final pieces (reply-stream.ts)
 * arrive as a `reply` event; the new ones are queued to the engine as one piece (`speak` with
 * `queue`), so the engine goes on from one to the next without a gap. `state.reading` holds what
 * was read so far (the view shows it with the tail still being written); words come in its
 * offsets. Once the queue runs dry while the agent still works it's "working" again (ticks); when
 * the run has ended and everything is read, it listens.
 *
 * The mic stays on the whole time (unless muted): talking over a reply stops it at once
 * (barge-in, `speech-start`) and listens; talking while the agent works sends the words like the
 * composer's Send (steer, or queued where the agent can't steer). A permission card is read out
 * ("… Allow?") and answered by voice (answers.ts); "no" picks the rejection and asks what to do
 * instead, and the next utterance is sent. The agent's other questions (I-193: pick one of
 * several, yes/no, type an answer) are read out and answered the same way. An unclear answer is
 * asked again once, then the question stays on screen (with buttons).
 */
import type { UiResponse } from "@glade/protocol";
import type { CueName } from "./engine";
import type { VoiceQuestion } from "./answers";
import { matchAnswer, retryText } from "./answers";
import { appendSpeakable, newPieces, sliceSpeakable, type ReplyPiece, type TurnPlan } from "./reply-stream";
import { plainSpeakable, type Speakable } from "./speakable";

export type AskStep =
  /** Reading the question. */
  | "question"
  /** Waiting for the answer (yes / yes always / no, an option, the text). */
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
  /** Reading the reply (`state.reading`). */
  | { name: "speaking" }
  | { name: "asking"; request: VoiceQuestion; step: AskStep; retried: boolean; speech: Speakable | null; word: [number, number] | null }
  | { name: "error"; message: string; retry: "send" | "listen" | "start"; text?: string }
  | { name: "closed" };

/** The latest turn's reply, as it's read (I-183). */
export interface Reading {
  /** The turn (its user message id; "" before the first). */
  turn: string;
  /** The reply's final pieces so far, joined: what is read and shown. */
  speech: Speakable;
  /** The keys of the pieces in `speech` (reply-stream.ts `newPieces`). */
  keys: string[];
  /** Text still being written after `speech` (shown, not read yet). */
  tail: ReplyPiece | null;
  /** How much of `speech.text` went to the engine (or was skipped). */
  queuedTo: number;
  /** Pieces the engine hasn't finished. */
  pending: number;
  /** The word being read, in `speech.text`. */
  word: [number, number] | null;
  /** Not read any further: barge-in, Stop, the user talked, or it was there before voice mode. */
  silenced: boolean;
  /** Shown in the view (not a reply that was there before, nor one the user talked over). */
  shown: boolean;
  /** Something of it was read. */
  spoke: boolean;
}

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
  /** The latest turn's reply. */
  reading: Reading | null;
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
  | { type: "run-end" }
  /**
   * The latest turn's reply so far (every chat snapshot). `silent`: note it without reading it
   * (the reply that was already there when voice mode opened).
   */
  | { type: "reply"; plan: TurnPlan; silent?: boolean }
  /** The agent asks something (a permission card or another question), `question` said aloud. */
  | { type: "question"; request: VoiceQuestion; question: string }
  | { type: "question-gone"; requestId: string }
  | { type: "word"; start: number; end: number }
  | { type: "speak-done" }
  | { type: "speak-cancelled" }
  | { type: "speak-error"; message: string }
  | { type: "tick" }
  | { type: "mute"; muted: boolean }
  | { type: "stop-speaking" }
  /** An answer button on screen. */
  | { type: "answer"; response: UiResponse }
  | { type: "retry" }
  | { type: "close" };

export type VoiceEffect =
  | { type: "start" }
  | { type: "listen" }
  | { type: "stop-listening" }
  /**
   * `queue`: after what's being read (the next piece of the reply). `offset`: where `speech`
   * starts in the reading, added to its word events.
   */
  | { type: "speak"; speech: Speakable; queue?: boolean; offset?: number }
  | { type: "stop-speaking" }
  | { type: "cue"; cue: CueName }
  | { type: "send"; text: string }
  | { type: "respond"; response: UiResponse }
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
  return { phase: { name: "starting" }, partial: "", heard: "", muted: false, running: false, notice: null, reading: null };
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

function newReading(turn: string, silent: boolean): Reading {
  return { turn, speech: { text: "", segments: [] }, keys: [], tail: null, queuedTo: 0, pending: 0, word: null, silenced: silent, shown: !silent, spoke: false };
}

/** The reading stopped where it is: nothing of it is read any more (still shown unless `hide`). */
function silence(reading: Reading | null, hide = false): Reading | null {
  if (!reading) return null;
  return { ...reading, silenced: true, shown: reading.shown && !hide, pending: 0, word: null, queuedTo: reading.speech.text.length };
}

/** The engine stopped reading (a question took over): what was queued is skipped, what comes later is read. */
function skipQueued(reading: Reading | null): Reading | null {
  if (!reading) return null;
  return { ...reading, pending: 0, word: null, queuedTo: reading.speech.text.length };
}

/**
 * Hands what's final and not read yet to the engine, when the conversation can read: not while
 * starting, asking, failed, or while the user is talking (then it waits for the next snapshot).
 */
function pump(state: VoiceState, effects: VoiceEffect[]): VoiceState {
  const r = state.reading;
  if (!r || r.silenced || r.queuedTo >= r.speech.text.length) return state;
  const phase = state.phase;
  if (phase.name === "asking" || phase.name === "error" || phase.name === "unavailable") {
    return { ...state, reading: skipQueued(r) };
  }
  const canRead = phase.name === "speaking" || ((phase.name === "listening" || phase.name === "working" || phase.name === "sending") && !state.partial);
  if (!canRead) return state;
  let from = r.queuedTo;
  while (from < r.speech.text.length && /\s/.test(r.speech.text[from]!)) from++;
  const reading: Reading = { ...r, queuedTo: r.speech.text.length, spoke: true };
  if (from >= r.speech.text.length) return { ...state, reading };
  effects.push({ type: "speak", speech: sliceSpeakable(r.speech, from, r.speech.text.length), queue: r.pending > 0, offset: from });
  reading.pending = r.pending + 1;
  if (phase.name !== "speaking") effects.push({ type: "ticker", on: false });
  return { ...state, reading, phase: { name: "speaking" } };
}

/** A new snapshot of the turn's reply: add its new final pieces and read them. */
function onReply(state: VoiceState, plan: TurnPlan, silent: boolean, effects: VoiceEffect[]): VoiceState {
  let r = state.reading;
  if (!r || r.turn !== plan.turn) r = newReading(plan.turn, silent);
  let speech = r.speech;
  const keys = [...r.keys];
  for (const piece of newPieces(r.keys, plan.pieces)) {
    speech = appendSpeakable(speech, piece.sep, piece.speech);
    keys.push(piece.key);
  }
  r = { ...r, speech, keys, tail: plan.tail };
  if (r.silenced) r.queuedTo = speech.text.length;
  return pump({ ...state, reading: r }, effects);
}

export function step(state: VoiceState, event: VoiceEvent): StepResult {
  const effects: VoiceEffect[] = [];
  const phase = state.phase;
  const done = (next: Partial<VoiceState>): StepResult => ({ state: { ...state, ...next }, effects });
  if (phase.name === "closed") return { state, effects };

  switch (event.type) {
    case "close":
      effects.push({ type: "ticker", on: false }, { type: "stop-speaking" }, { type: "stop-listening" }, { type: "end-session" });
      return done({ phase: { name: "closed" }, partial: "", reading: silence(state.reading) });

    case "started": {
      const next = { ...state, running: event.running };
      if (!state.muted) effects.push({ type: "listen" });
      effects.push({ type: "cue", cue: "listening" });
      return { state: pump({ ...next, phase: rest(next, effects), notice: null }, effects), effects };
    }
    case "unavailable":
      return done({ phase: { name: "unavailable", reason: event.reason } });
    case "start-failed":
      effects.push({ type: "cue", cue: "error" });
      return done({ phase: { name: "error", message: event.message, retry: "start" } });
    case "reply":
      // Also while starting: noted now, read once the session is up.
      return { state: onReply(state, event.plan, !!event.silent, effects), effects };
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
      // Barge-in: stop talking at once and listen; the rest of this reply isn't read.
      if (phase.name === "speaking") {
        effects.push({ type: "stop-speaking" });
        return done({ phase: rest(state, effects), reading: silence(state.reading) });
      }
      if (phase.name === "asking" && phase.speech) {
        effects.push({ type: "stop-speaking" });
        return done({ phase: { ...phase, step: phase.step === "question" ? "answer" : phase.step, speech: null, word: null } });
      }
      return { state, effects };

    case "final": {
      const text = event.text.trim();
      if (!text) return { state: pump({ ...state, partial: "" }, effects), effects };
      if (isSpeaking(phase)) effects.push({ type: "stop-speaking" });
      if (phase.name === "asking" && phase.step !== "instead") {
        const response = matchAnswer(phase.request, text);
        if (response) return answered(state, phase, response, text, effects);
        if (!phase.retried) {
          const speech = plainSpeakable(retryText(phase.request));
          effects.push({ type: "speak", speech });
          return done({ partial: "", heard: text, phase: { ...phase, step: "question", retried: true, speech, word: null } });
        }
        const speech = plainSpeakable(SCREEN_NOTICE);
        effects.push({ type: "speak", speech });
        return done({ partial: "", heard: text, phase: { ...phase, step: "screen", speech, word: null } });
      }
      // Sent like the composer's Send (while the agent works: steer or queue). The reply being
      // written stops being read (and shown); the next turn's reply is read again.
      effects.push({ type: "ticker", on: false }, { type: "cue", cue: "sent" }, { type: "send", text });
      return done({ partial: "", heard: text, phase: { name: "sending", text }, reading: silence(state.reading, true) });
    }

    case "listen-error":
      if (event.recoverable) return done({ notice: event.message });
      effects.push({ type: "ticker", on: false }, { type: "cue", cue: "error" });
      if (isSpeaking(phase)) effects.push({ type: "stop-speaking" });
      return done({ partial: "", phase: { name: "error", message: event.message, retry: "listen" }, reading: skipQueued(state.reading) });

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
      // Still reading: the rest is read, then it listens. Still asking (e.g. the run was stopped):
      // the question goes away with its request.
      if (!idle) return done({ running: false });
      // Nothing was read for this run (no reply, or it was talked over): a cue says it's done.
      if (!state.reading?.spoke || state.reading.silenced) effects.push({ type: "cue", cue: "done" });
      return done({ running: false, phase: rest(next, effects) });
    }

    case "question": {
      if (isSpeaking(phase)) effects.push({ type: "stop-speaking" });
      const speech = plainSpeakable(event.question);
      effects.push({ type: "ticker", on: false }, { type: "speak", speech });
      return done({ partial: "", reading: skipQueued(state.reading), phase: { name: "asking", request: event.request, step: "question", retried: false, speech, word: null } });
    }

    case "question-gone":
      if (phase.name !== "asking" || phase.request.id !== event.requestId || phase.step === "instead") return { state, effects };
      if (phase.speech) effects.push({ type: "stop-speaking" });
      return done({ phase: rest(state, effects) });

    case "word":
      if (phase.name === "speaking" && state.reading) return done({ reading: { ...state.reading, word: [event.start, event.end] } });
      if (phase.name === "asking" && phase.speech) return done({ phase: { ...phase, word: [event.start, event.end] } });
      return { state, effects };

    case "speak-done":
      if (phase.name === "speaking") {
        const r = state.reading;
        const pending = Math.max(0, (r?.pending ?? 1) - 1);
        if (r && pending > 0) return done({ reading: { ...r, pending } });
        // Read up to here: back to working (ticks) while the agent writes on, or listening.
        return done({ phase: rest(state, effects), reading: r && { ...r, pending: 0, word: null } });
      }
      return finishQuestion(state, effects);

    case "speak-error":
    case "speak-cancelled":
      if (phase.name === "speaking") {
        // Cut off (an interruption, the audio route changed): the rest of the reply isn't read.
        effects.push({ type: "stop-speaking" });
        return done({ phase: rest(state, effects), reading: silence(state.reading) });
      }
      return finishQuestion(state, effects);

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
        return done({ phase: rest(state, effects), reading: silence(state.reading) });
      }
      if (phase.name === "asking" && phase.speech) {
        effects.push({ type: "stop-speaking" });
        return done({ phase: { ...phase, step: phase.step === "question" ? "answer" : phase.step, speech: null, word: null } });
      }
      return { state, effects };

    case "answer":
      if (phase.name !== "asking" || phase.step === "instead") return { state, effects };
      if (phase.speech) effects.push({ type: "stop-speaking" });
      return answered(state, phase, event.response, state.heard, effects);

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

/** A question (or the "instead" prompt) was read to the end or cut off: wait for the answer. */
function finishQuestion(state: VoiceState, effects: VoiceEffect[]): StepResult {
  const phase = state.phase;
  if (phase.name === "asking" && phase.speech) {
    return { state: { ...state, phase: { ...phase, step: phase.step === "question" ? "answer" : phase.step, speech: null, word: null } }, effects };
  }
  return { state, effects };
}

function answered(state: VoiceState, phase: Phase & { name: "asking" }, response: UiResponse, heard: string, effects: VoiceEffect[]): StepResult {
  const request = phase.request;
  const option = request.kind === "permission" && "value" in response ? request.options.find((o) => o.id === response.value) : undefined;
  effects.push({ type: "respond", response });
  if (option?.kind.startsWith("reject") && option.focusComposer) {
    // "No, and tell … what to do differently": the next utterance is the new instruction.
    const speech = plainSpeakable(INSTEAD_QUESTION);
    effects.push({ type: "speak", speech });
    return { state: { ...state, partial: "", heard, phase: { ...phase, step: "instead", speech, word: null } }, effects };
  }
  return { state: { ...state, partial: "", heard, phase: rest(state, effects) }, effects };
}
