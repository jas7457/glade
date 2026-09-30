/**
 * Conversation mode's voice engine (I-180): the contract between the native side (a Tauri iOS
 * plugin: Apple on-device speech recognition and Apple voices) and the voice view / conversation
 * state machine in `apps/iphone/src/voice/`. Everything above this file talks to a `VoiceEngine`;
 * tests and the simulator use `createFakeVoiceEngine()` (fake-engine.ts), the app uses the native one.
 *
 * Audio: while a session is active the engine owns the audio session (play-and-record with voice
 * processing, so the mic ignores the phone's own speech and the user can talk over a reply).
 */

export type VoicePermission = "granted" | "denied" | "undetermined" | "restricted";

export interface VoicePermissions {
  microphone: VoicePermission;
  speechRecognition: VoicePermission;
}

export type VoiceQuality = "default" | "enhanced" | "premium";

export interface VoiceInfo {
  /** AVSpeechSynthesisVoice.identifier */
  id: string;
  name: string;
  /** BCP-47, e.g. "en-US". */
  language: string;
  quality: VoiceQuality;
  /** A Personal Voice (usable once the user allows it). */
  personal?: boolean;
}

/** Recognition events while listening. */
export type ListenEvent =
  /** The user started speaking (use it for barge-in: stop speaking at once). */
  | { type: "speech-start" }
  /** The best transcript so far for this utterance (replaces the previous partial). */
  | { type: "partial"; text: string }
  /** The utterance ended (a pause of `endSilenceMs`); `text` is final. */
  | { type: "final"; text: string }
  /**
   * Recognition failed or was interrupted (e.g. another app took the audio). `recoverable: true`:
   * the engine keeps listening by itself. `false`: listening has stopped (no permission, no
   * on-device model, repeated failures, an interruption or audio reset); call `startListening` again.
   */
  | { type: "error"; message: string; recoverable: boolean };

export interface ListenOptions {
  /** BCP-47 locale for recognition; default the device's. */
  locale?: string;
  /** Silence that ends an utterance. Default 1200 ms. */
  endSilenceMs?: number;
  /** Words to bias recognition toward (e.g. "yes", "always", project names). */
  contextualStrings?: string[];
}

/** Synthesis events for one `speak` call (queued calls each get their own). */
export type SpeakEvent =
  /** The word being spoken: [start, end) character offsets into this call's text. */
  | { type: "word"; start: number; end: number }
  | { type: "done" }
  /** Stopped by `stopSpeaking` (or barge-in). */
  | { type: "cancelled" }
  | { type: "error"; message: string };

export interface SpeakOptions {
  voiceId?: string;
  /** 0.5 … 2, 1 = normal (maps to AVSpeechUtterance rates). */
  rate?: number;
  /**
   * Speak after what is being spoken (and anything queued) instead of replacing it (I-183: the
   * next sentences of a streaming reply). The engine prepares it while the current text plays, so
   * it follows without a gap; when nothing is playing it starts at once. Default false: `speak`
   * stops everything (each stopped call gets `cancelled`) and starts this text.
   */
  queue?: boolean;
}

/** Short sounds (bundled or system) for state changes and the "still working" cue. */
export type CueName = "listening" | "sent" | "working" | "working-tick" | "done" | "error";

export interface VoiceEngine {
  /** Whether this device can do on-device recognition + synthesis at all. */
  isAvailable(): Promise<boolean>;
  permissions(): Promise<VoicePermissions>;
  /** Prompts for whatever is still undetermined; resolves with the result. */
  requestPermissions(): Promise<VoicePermissions>;

  /** Installed voices (all languages; never prompts). */
  listVoices(): Promise<VoiceInfo[]>;
  /** Ask to use the user's Personal Voice (optional; engines without it omit this). */
  requestPersonalVoice?(): Promise<VoicePermission>;

  /** Take the audio session (voice processing on) and keep the screen awake. */
  startSession(): Promise<void>;
  /** Release the audio session and let the screen sleep again. */
  endSession(): Promise<void>;

  /** Start listening; events arrive until `stopListening` (continues across utterances). */
  startListening(options: ListenOptions, onEvent: (e: ListenEvent) => void): Promise<void>;
  stopListening(): Promise<void>;

  /**
   * Speak `text`; resolves when accepted. Events report words, done or cancelled, per call: with
   * `queue`, each call's `done` comes when its own text has been played.
   */
  speak(text: string, options: SpeakOptions, onEvent: (e: SpeakEvent) => void): Promise<void>;
  /** Stops what's being spoken and everything queued (each gets `cancelled`). */
  stopSpeaking(): Promise<void>;

  playCue(cue: CueName): Promise<void>;
}
