/**
 * The native `VoiceEngine` (I-180): a thin adapter over the iOS `voice` plugin
 * (src-tauri/plugins/voice, Swift). Commands go through Tauri's `invoke("plugin:voice|…")`; the
 * streaming callbacks (recognition and synthesis events) come back over one Tauri `Channel` per
 * `startListening` / `speak` call. Events from a channel that is no longer current (after
 * `stopListening`, a newer `startListening`, or a finished reply) are dropped here, so the UI never
 * sees stragglers. Queued `speak` calls (`queue: true`, I-183) each have their own channel and stay
 * current alongside the one being spoken; a non-queued `speak` replaces them all.
 *
 * Word offsets: the plugin reports AVSpeechSynthesizer's NSRange, which counts UTF-16 code units;
 * JS strings index UTF-16 code units too, so `word.start/end` index the spoken text directly.
 *
 * `getVoiceEngine()` picks the native engine inside the iPhone app and the fake one elsewhere
 * (Vite in Chrome, tests).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { inShell } from "~/lib/secrets";
import type {
  CueName,
  ListenEvent,
  ListenOptions,
  SpeakEvent,
  SpeakOptions,
  VoiceEngine,
  VoiceInfo,
  VoicePermission,
  VoicePermissions,
} from "~/voice/engine";
import { createFakeVoiceEngine } from "~/voice/fake-engine";

/** What the adapter needs from Tauri (injected in tests). */
export interface NativeBridge {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  /** A channel whose messages go to `onMessage`; it is passed to the plugin as an argument. */
  channel<T>(onMessage: (message: T) => void): unknown;
}

export const tauriBridge: NativeBridge = {
  invoke: (cmd, args) => invoke(cmd, args),
  channel: (onMessage) => new Channel(onMessage),
};

/** The native engine plus what the plugin offers beyond the contract. */
export interface NativeVoiceEngine extends VoiceEngine {
  /** Ask to use the user's Personal Voice (iOS prompts once); then `listVoices` includes it. */
  requestPersonalVoice(): Promise<VoicePermission>;
}

const cmd = (name: string) => `plugin:voice|${name}`;

export function createNativeVoiceEngine(bridge: NativeBridge = tauriBridge): NativeVoiceEngine {
  // Only the latest listen/speak channel may deliver events.
  let listenToken = 0;
  let speakToken = 0;

  return {
    async isAvailable() {
      try {
        return (await bridge.invoke<{ value: boolean }>(cmd("is_available"))).value;
      } catch {
        return false;
      }
    },
    permissions: () => bridge.invoke<VoicePermissions>(cmd("get_permissions")),
    requestPermissions: () => bridge.invoke<VoicePermissions>(cmd("request_permissions")),
    async requestPersonalVoice() {
      return (await bridge.invoke<{ value: VoicePermission }>(cmd("request_personal_voice"))).value;
    },
    async listVoices() {
      return (await bridge.invoke<{ voices: VoiceInfo[] }>(cmd("list_voices"))).voices;
    },
    startSession: () => bridge.invoke<void>(cmd("start_session")),
    async endSession() {
      listenToken++;
      speakToken++;
      await bridge.invoke<void>(cmd("end_session"));
    },

    async startListening(options: ListenOptions, onEvent: (e: ListenEvent) => void) {
      const token = ++listenToken;
      const onEvent_ = bridge.channel<ListenEvent>((e) => {
        if (token !== listenToken) return;
        // A non-recoverable error ends this listening run on the native side.
        if (e.type === "error" && !e.recoverable) listenToken++;
        onEvent(e);
      });
      try {
        await bridge.invoke<void>(cmd("start_listening"), {
          locale: options.locale,
          endSilenceMs: options.endSilenceMs ?? 1200,
          contextualStrings: options.contextualStrings ?? [],
          onEvent: onEvent_,
        });
      } catch (err) {
        if (token === listenToken) listenToken++;
        throw err;
      }
    },
    async stopListening() {
      listenToken++;
      await bridge.invoke<void>(cmd("stop_listening"));
    },

    async speak(text: string, options: SpeakOptions, onEvent: (e: SpeakEvent) => void) {
      // Queued: part of what's being spoken; otherwise it replaces everything before it.
      const token = options.queue ? speakToken : ++speakToken;
      let ended = false;
      const onEvent_ = bridge.channel<SpeakEvent>((e) => {
        // Each reply ends once (done / cancelled / error). A replaced reply still gets its
        // `cancelled`, but no more words.
        if (ended || (e.type === "word" && token !== speakToken)) return;
        if (e.type !== "word") ended = true;
        onEvent(e);
      });
      try {
        await bridge.invoke<void>(cmd("speak"), { text, voiceId: options.voiceId, rate: options.rate ?? 1, queue: options.queue ?? false, onEvent: onEvent_ });
      } catch (err) {
        ended = true;
        throw err;
      }
    },
    stopSpeaking: () => bridge.invoke<void>(cmd("stop_speaking")),

    playCue: (cue: CueName) => bridge.invoke<void>(cmd("play_cue"), { cue }),
  };
}

let engine: VoiceEngine | null = null;

/** The app's voice engine: native inside the iPhone app, the fake one anywhere else. */
export function getVoiceEngine(): VoiceEngine {
  engine ??= inShell() ? createNativeVoiceEngine() : createFakeVoiceEngine();
  return engine;
}
