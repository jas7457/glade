/**
 * A fake `VoiceEngine` (I-180) for tests, the browser and the simulator (where on-device speech
 * isn't available). It "speaks" on a timer (a `word` event per word, then `done`; `stopSpeaking`
 * sends `cancelled`) and "hears" whatever `hear(text)` is given: `speech-start`, a partial per word,
 * then `final`. Tests can also push raw events (`emitListen`) and read what was called (`calls`).
 *
 *   const engine = createFakeVoiceEngine({ wordMs: 0 });   // 0: words only when `step()` is called
 *   engine.hear("run the tests");
 */
import type { CueName, ListenEvent, ListenOptions, SpeakEvent, SpeakOptions, VoiceEngine, VoiceInfo, VoicePermissions } from "./engine";

export interface FakeVoiceEngineOptions {
  available?: boolean;
  permissions?: VoicePermissions;
  /** What `requestPermissions` grants (default: everything). */
  grant?: VoicePermissions;
  voices?: VoiceInfo[];
  /** Time per spoken word at rate 1 (default 260 ms). 0: only `step()` advances. */
  wordMs?: number;
  /** Time per heard word (partials) in `hear` (default 120 ms). 0: all at once. */
  hearMs?: number;
}

export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeVoiceEngine extends VoiceEngine {
  readonly fake: true;
  /** Every call, in order (`speak` records its text). */
  calls: FakeCall[];
  cues: CueName[];
  listening: boolean;
  sessionActive: boolean;
  /** The text being spoken, or null. */
  speaking: string | null;
  /** Pretend the user said `text` (speech-start, partials, final). Resolves once the final was sent. */
  hear(text: string): Promise<void>;
  /** Push a recognition event to the current listener. */
  emitListen(event: ListenEvent): void;
  /** Speak the next word (or finish) of the current utterance. */
  step(): void;
  /** Finish the current utterance at once (`done`). */
  finishSpeaking(): void;
  /** Fail the current utterance. */
  failSpeaking(message: string): void;
  setPermissions(p: VoicePermissions): void;
}

export const FAKE_VOICES: VoiceInfo[] = [
  { id: "com.apple.voice.compact.en-US.Samantha", name: "Samantha", language: "en-US", quality: "default" },
  { id: "com.apple.voice.enhanced.en-US.Evan", name: "Evan", language: "en-US", quality: "enhanced" },
  { id: "com.apple.voice.premium.en-GB.Serena", name: "Serena", language: "en-GB", quality: "premium" },
  { id: "com.apple.voice.compact.fr-FR.Thomas", name: "Thomas", language: "fr-FR", quality: "default" },
];

const GRANTED: VoicePermissions = { microphone: "granted", speechRecognition: "granted" };

export function createFakeVoiceEngine(options: FakeVoiceEngineOptions = {}): FakeVoiceEngine {
  const wordMs = options.wordMs ?? 260;
  const hearMs = options.hearMs ?? 120;
  let permissions: VoicePermissions = options.permissions ?? GRANTED;
  let listener: ((e: ListenEvent) => void) | null = null;
  let utterance: { text: string; words: Array<[number, number]>; next: number; rate: number; onEvent: (e: SpeakEvent) => void } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (!utterance || wordMs <= 0) return;
    timer = setTimeout(() => {
      engine.step();
      schedule();
    }, wordMs / utterance.rate);
  };

  const engine: FakeVoiceEngine = {
    fake: true,
    calls: [],
    cues: [],
    listening: false,
    sessionActive: false,
    speaking: null,

    async isAvailable() {
      engine.calls.push({ method: "isAvailable", args: [] });
      return options.available ?? true;
    },
    async permissions() {
      return permissions;
    },
    async requestPermissions() {
      engine.calls.push({ method: "requestPermissions", args: [] });
      const grant = options.grant ?? GRANTED;
      permissions = {
        microphone: permissions.microphone === "undetermined" ? grant.microphone : permissions.microphone,
        speechRecognition: permissions.speechRecognition === "undetermined" ? grant.speechRecognition : permissions.speechRecognition,
      };
      return permissions;
    },
    async listVoices() {
      return options.voices ?? FAKE_VOICES;
    },
    async startSession() {
      engine.calls.push({ method: "startSession", args: [] });
      engine.sessionActive = true;
    },
    async endSession() {
      engine.calls.push({ method: "endSession", args: [] });
      engine.sessionActive = false;
      listener = null;
      engine.listening = false;
      await engine.stopSpeaking();
    },
    async startListening(opts: ListenOptions, onEvent) {
      engine.calls.push({ method: "startListening", args: [opts] });
      listener = onEvent;
      engine.listening = true;
    },
    async stopListening() {
      engine.calls.push({ method: "stopListening", args: [] });
      listener = null;
      engine.listening = false;
    },
    async speak(text: string, opts: SpeakOptions, onEvent) {
      engine.calls.push({ method: "speak", args: [text, opts] });
      if (utterance) {
        const prev = utterance;
        utterance = null;
        prev.onEvent({ type: "cancelled" });
      }
      const words: Array<[number, number]> = [];
      for (const m of text.matchAll(/\S+/g)) words.push([m.index, m.index + m[0].length]);
      utterance = { text, words, next: 0, rate: opts.rate ?? 1, onEvent };
      engine.speaking = text;
      schedule();
    },
    async stopSpeaking() {
      engine.calls.push({ method: "stopSpeaking", args: [] });
      clear();
      const u = utterance;
      utterance = null;
      engine.speaking = null;
      u?.onEvent({ type: "cancelled" });
    },
    async playCue(cue) {
      engine.cues.push(cue);
    },

    async hear(text) {
      const say = (e: ListenEvent) => listener?.(e);
      const words = text.trim().split(/\s+/).filter(Boolean);
      if (!listener || words.length === 0) return;
      say({ type: "speech-start" });
      for (let i = 1; i <= words.length; i++) {
        if (hearMs > 0) await new Promise((r) => setTimeout(r, hearMs));
        say({ type: "partial", text: words.slice(0, i).join(" ") });
      }
      say({ type: "final", text: words.join(" ") });
    },
    emitListen(event) {
      listener?.(event);
    },
    step() {
      const u = utterance;
      if (!u) return;
      const word = u.words[u.next];
      if (word) {
        u.next++;
        u.onEvent({ type: "word", start: word[0], end: word[1] });
        return;
      }
      engine.finishSpeaking();
    },
    finishSpeaking() {
      clear();
      const u = utterance;
      utterance = null;
      engine.speaking = null;
      u?.onEvent({ type: "done" });
    },
    failSpeaking(message) {
      clear();
      const u = utterance;
      utterance = null;
      engine.speaking = null;
      u?.onEvent({ type: "error", message });
    },
    setPermissions(p) {
      permissions = p;
    },
  };
  return engine;
}

export function isFakeVoiceEngine(engine: VoiceEngine): engine is FakeVoiceEngine {
  return (engine as Partial<FakeVoiceEngine>).fake === true;
}
