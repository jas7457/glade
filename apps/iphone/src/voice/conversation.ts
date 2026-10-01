/**
 * Runs a conversation (I-180): feeds the state machine (machine.ts) with the voice engine's events
 * and the chat's (running, permission cards, the reply as it streams), and carries out its effects
 * on the engine and the chat. The view reads `conversation.state`.
 *
 * Every chat snapshot's reply goes to the machine as a plan of final pieces (reply-stream.ts), so
 * it's read while it streams; pieces go to the engine queued (`speak` with `queue`), and their
 * word events are moved by the piece's offset into the whole reading.
 *
 * The chat side is a `VoiceChat` (so tests use a fake one): `chatVoiceBridge(sessionId)` for an
 * open chat, `newChatVoiceBridge(start)` for New Chat, where the first utterance starts the chat
 * (the composer's `startRef`) and the conversation continues in it.
 */
import { effect, signal, untracked, type ReadonlySignal } from "@preact/signals";
import type { Transcript, UiRequest, UiResponse } from "@glade/protocol";
import { getChatSession, runAction } from "@glade/app-core/state/chat-session";
import { apiForSession } from "@glade/app-core/state/env-api";
import { harnessCapabilities, harnessLabel } from "@glade/app-core/state/harnesses";
import { envIdOfSession, sessionsById } from "@glade/app-core/state/store";
import { ANSWER_WORDS, isVoiceQuestion, questionText, type VoiceQuestion } from "./answers";
import type { ListenEvent, SpeakEvent, VoiceEngine } from "./engine";
import { initialVoiceState, step, type VoiceEffect, type VoiceEvent, type VoiceState } from "./machine";
import { planTurn } from "./reply-stream";

export interface ChatSnapshot {
  isRunning: boolean;
  transcript: Transcript;
  /** The first pending question when voice can answer it (permission, select, confirm, input). */
  question: VoiceQuestion | null;
  /** A question voice can't answer is pending (an editor): answered on screen. */
  otherRequest: boolean;
}

export interface VoiceChat {
  /** Calls `onChange` with the chat's current snapshot now and whenever it changes. */
  watch(onChange: (s: ChatSnapshot) => void): () => void;
  /** Sends like the composer's Send (steers / queues while the agent works). */
  send(text: string): Promise<{ ok: true } | { ok: false; message: string }>;
  respond(response: UiResponse): void;
  /** The agent's name for questions ("Claude Code wants to …"); null: "The agent". */
  agentName(): string | null;
  /** The chat's session id (null until New Chat's first message created it). */
  sessionId(): string | null;
}

export interface ConversationOptions {
  /** The "still working" cue's interval. */
  tickMs?: number;
  /** Silence that ends an utterance (read at every `listen`: Settings → Voice can change it). */
  endSilenceMs?: number | (() => number);
  /** Voice and rate for speaking (read at every `speak`). */
  voice?: () => { voiceId?: string; rate?: number };
}

export class Conversation {
  private readonly _state = signal<VoiceState>(initialVoiceState());
  readonly state: ReadonlySignal<VoiceState> = this._state;
  /** The chat's last snapshot (the view shows other pending questions from it). */
  readonly chat = signal<ChatSnapshot | null>(null);
  private queue: VoiceEvent[] = [];
  private busy = false;
  private speakToken = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private unwatch: (() => void) | null = null;
  private running: boolean | null = null;
  private askedId: string | null = null;
  /** Messages when the last send went out: a run too quick to be seen still counts (see onChat). */
  private sentAt: number | null = null;

  constructor(
    private readonly engine: VoiceEngine,
    private readonly bridge: VoiceChat,
    private readonly options: ConversationOptions = {},
  ) {}

  /** Checks availability and permissions, takes the audio session, starts listening. */
  start(): void {
    this.unwatch ??= this.bridge.watch((s) => this.onChat(s));
    this.run({ type: "start" });
  }

  dispatch(event: VoiceEvent): void {
    this.queue.push(event);
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const next = this.queue.shift()!;
        const { state, effects } = step(this._state.value, next);
        this._state.value = state;
        for (const e of effects) this.run(e);
      }
    } finally {
      this.busy = false;
    }
  }

  close(): void {
    this.dispatch({ type: "close" });
    this.unwatch?.();
    this.unwatch = null;
  }

  private onChat(s: ChatSnapshot): void {
    this.chat.value = s;
    if (this.running === null) {
      // First look: a run in progress means we start out "working" and read its reply from the
      // start; a finished reply is only noted (not read, not shown).
      this.running = s.isRunning;
      if (s.isRunning) this.dispatch({ type: "run-start" });
      this.dispatch({ type: "reply", plan: planTurn(s.transcript, !s.isRunning), silent: !s.isRunning });
    } else if (s.isRunning !== this.running) {
      this.running = s.isRunning;
      this.sentAt = null;
      // The reply first (at the end: everything left is final), then the run's end.
      this.dispatch({ type: "reply", plan: planTurn(s.transcript, !s.isRunning) });
      this.dispatch(s.isRunning ? { type: "run-start" } : { type: "run-end" });
    } else if (!s.isRunning && this.sentAt !== null && this._state.value.phase.name === "sending") {
      // A run that started and ended between two looks: its reply is already here.
      const fresh = s.transcript.messages.slice(this.sentAt);
      if (fresh.some((m) => m.role === "user") && fresh.some((m) => m.role === "assistant" && !m.streaming)) {
        this.sentAt = null;
        this.dispatch({ type: "run-start" });
        this.dispatch({ type: "reply", plan: planTurn(s.transcript, true) });
        this.dispatch({ type: "run-end" });
      }
    } else {
      this.dispatch({ type: "reply", plan: planTurn(s.transcript, !s.isRunning) });
    }
    const asked = s.question;
    if (asked && asked.id !== this.askedId) {
      const gone = this.askedId;
      this.askedId = asked.id;
      if (gone) this.dispatch({ type: "question-gone", requestId: gone });
      this.dispatch({ type: "question", request: asked, question: questionText(asked, this.bridge.agentName()) });
    } else if (!asked && this.askedId) {
      const gone = this.askedId;
      this.askedId = null;
      this.dispatch({ type: "question-gone", requestId: gone });
    }
  }

  private run(effect: VoiceEffect): void {
    const engine = this.engine;
    switch (effect.type) {
      case "start":
        void this.boot();
        return;
      case "listen":
        engine
          .startListening({ endSilenceMs: this.endSilenceMs(), contextualStrings: ANSWER_WORDS }, (e) => this.dispatch(listenEvent(e)))
          .catch((err: Error) => this.dispatch({ type: "listen-error", message: err.message || "Can't listen", recoverable: false }));
        return;
      case "stop-listening":
        void engine.stopListening().catch(() => {});
        return;
      case "speak": {
        // A queued piece belongs to what's being read; anything else replaces it.
        const token = effect.queue ? this.speakToken : ++this.speakToken;
        const offset = effect.offset ?? 0;
        const onEvent = (e: SpeakEvent) => {
          if (token !== this.speakToken) return;
          this.dispatch(e.type === "word" ? { type: "word", start: e.start + offset, end: e.end + offset } : speakEvent(e));
        };
        const options = { ...(this.options.voice?.() ?? {}), ...(effect.queue ? { queue: true } : {}) };
        engine.speak(effect.speech.text, options, onEvent).catch((err: Error) => onEvent({ type: "error", message: err.message }));
        return;
      }
      case "stop-speaking":
        // Its `cancelled` belongs to what we stopped, not to whatever is spoken next.
        this.speakToken++;
        void engine.stopSpeaking().catch(() => {});
        return;
      case "cue":
        void engine.playCue(effect.cue).catch(() => {});
        return;
      case "send":
        this.sentAt = this.chat.value?.transcript.messages.length ?? 0;
        void this.bridge.send(effect.text).then((r) => {
          if (r.ok) this.dispatch({ type: "sent" });
          else this.dispatch({ type: "send-failed", message: r.message, text: effect.text });
          // A new chat (New Chat by voice) exists now: its first snapshot arrives by `watch`.
        });
        return;
      case "respond":
        this.askedId = effect.response.id;
        this.bridge.respond(effect.response);
        return;
      case "ticker":
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = effect.on ? setInterval(() => this.dispatch({ type: "tick" }), this.options.tickMs ?? 4500) : null;
        return;
      case "end-session":
        void engine.endSession().catch(() => {});
        return;
    }
  }

  private endSilenceMs(): number | undefined {
    const ms = this.options.endSilenceMs;
    return typeof ms === "function" ? ms() : ms;
  }

  private async boot(): Promise<void> {
    try {
      if (!(await this.engine.isAvailable())) return this.dispatch({ type: "unavailable", reason: "unsupported" });
      let p = await this.engine.permissions();
      if (p.microphone === "undetermined" || p.speechRecognition === "undetermined") p = await this.engine.requestPermissions();
      if (p.microphone !== "granted" || p.speechRecognition !== "granted") return this.dispatch({ type: "unavailable", reason: "denied" });
      await this.engine.startSession();
      if (this._state.value.phase.name === "closed") return void this.engine.endSession();
      this.dispatch({ type: "started", running: this.chat.value?.isRunning ?? false });
    } catch (err) {
      this.dispatch({ type: "start-failed", message: (err as Error).message || "Voice mode couldn't start" });
    }
  }
}

function listenEvent(e: ListenEvent): VoiceEvent {
  if (e.type === "error") return { type: "listen-error", message: e.message, recoverable: e.recoverable };
  return e;
}

function speakEvent(e: SpeakEvent): VoiceEvent {
  switch (e.type) {
    case "word":
      return { type: "word", start: e.start, end: e.end };
    case "done":
      return { type: "speak-done" };
    case "cancelled":
      return { type: "speak-cancelled" };
    case "error":
      return { type: "speak-error", message: e.message };
  }
}

// ---------------------------------------------------------------------------------------------
// The chat side, from app-core's chat state
// ---------------------------------------------------------------------------------------------

function snapshotOf(sessionId: string): ChatSnapshot {
  const store = getChatSession(sessionId);
  const requests: UiRequest[] = store.uiRequests.value;
  // Permission cards first (the agent is blocked on them), then the other questions in order.
  const question = requests.find((r) => r.kind === "permission") ?? requests.find(isVoiceQuestion) ?? null;
  return {
    isRunning: store.state.value.isRunning,
    transcript: store.transcript.value,
    question: question && isVoiceQuestion(question) ? question : null,
    otherRequest: requests.some((r) => !isVoiceQuestion(r)),
  };
}

function watchSession(sessionId: string, onChange: (s: ChatSnapshot) => void): () => void {
  return effect(() => {
    const snapshot = snapshotOf(sessionId);
    // The conversation reads and writes its own signals in `onChange`: not this effect's deps.
    untracked(() => onChange(snapshot));
  });
}

async function sendToSession(sessionId: string, text: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const store = getChatSession(sessionId);
  const summary = sessionsById.value.get(sessionId);
  const capabilities = harnessCapabilities(summary?.harness, envIdOfSession(sessionId));
  let message = "Could not send the message";
  const ok = await runAction(async () => {
    try {
      await apiForSession(sessionId).prompt(sessionId, { text, behavior: store.state.value.isRunning && capabilities.steering ? "steer" : undefined });
    } catch (err) {
      message = (err as Error).message || message;
      throw err;
    }
  }, "Could not send message");
  return ok ? { ok: true } : { ok: false, message };
}

function respondIn(sessionId: string, response: UiResponse): void {
  const store = getChatSession(sessionId);
  store.uiRequests.value = store.uiRequests.value.filter((r) => r.id !== response.id);
  void runAction(() => apiForSession(sessionId).respondToUi(sessionId, response), "Could not send answer");
}

function agentNameOf(sessionId: string): string | null {
  const summary = sessionsById.value.get(sessionId);
  const label = summary?.harness ? harnessLabel(summary.harness, envIdOfSession(sessionId)) : null;
  return label && label !== "the agent" ? label : null;
}

/** An open chat. */
export function chatVoiceBridge(sessionId: string): VoiceChat {
  return {
    watch: (onChange) => watchSession(sessionId, onChange),
    send: (text) => sendToSession(sessionId, text),
    respond: (response) => respondIn(sessionId, response),
    agentName: () => agentNameOf(sessionId),
    sessionId: () => sessionId,
  };
}

/**
 * New Chat: the first `send` starts the chat with `start` (resolves its session id, or null when
 * it failed); from then on it's that chat's bridge.
 */
export function newChatVoiceBridge(start: (text: string) => Promise<string | null>, onCreated?: (sessionId: string) => void): VoiceChat {
  let sessionId: string | null = null;
  let listener: ((s: ChatSnapshot) => void) | null = null;
  let unwatch: (() => void) | null = null;
  const empty: ChatSnapshot = { isRunning: false, transcript: { messages: [], toolResults: {} }, question: null, otherRequest: false };
  return {
    watch(onChange) {
      listener = onChange;
      onChange(empty);
      return () => {
        listener = null;
        unwatch?.();
      };
    },
    async send(text) {
      if (sessionId) return sendToSession(sessionId, text);
      const id = await start(text);
      if (!id) return { ok: false, message: "Could not start the chat" };
      sessionId = id;
      onCreated?.(id);
      if (listener) unwatch = watchSession(id, listener);
      return { ok: true };
    },
    respond: (response) => sessionId && respondIn(sessionId, response),
    agentName: () => (sessionId ? agentNameOf(sessionId) : null),
    sessionId: () => sessionId,
  };
}
