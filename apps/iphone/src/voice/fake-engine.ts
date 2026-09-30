/**
 * PLACEHOLDER (voice-native's branch only, so native-engine.ts compiles): the real fake engine is
 * voice-ui's `apps/iphone/src/voice/fake-engine.ts`; on merge, take theirs.
 */
import type { VoiceEngine } from "~/voice/engine";

export function createFakeVoiceEngine(): VoiceEngine {
  const none = async () => {};
  return {
    isAvailable: async () => false,
    permissions: async () => ({ microphone: "undetermined", speechRecognition: "undetermined" }),
    requestPermissions: async () => ({ microphone: "denied", speechRecognition: "denied" }),
    listVoices: async () => [],
    startSession: none,
    endSession: none,
    startListening: none,
    stopListening: none,
    speak: async (_text, _options, onEvent) => onEvent({ type: "done" }),
    stopSpeaking: none,
    playCue: none,
  };
}
