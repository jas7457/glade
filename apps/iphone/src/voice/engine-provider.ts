/**
 * The app's one `VoiceEngine` (I-180). Until the native engine lands this is the fake one
 * (fake-engine.ts: speaks on a timer, "hears" what's typed into the voice view's debug field).
 *
 * To switch to the native engine (apps/iphone/src/voice/native-engine.ts, which falls back to the
 * fake outside the iOS app), replace the body of `voiceEngine()` with `return (engine ??= getVoiceEngine());`
 * and import `getVoiceEngine` from "./native-engine".
 *
 * Tests install their own with `setVoiceEngine()`.
 */
import type { VoiceEngine } from "./engine";
import { createFakeVoiceEngine } from "./fake-engine";

let engine: VoiceEngine | null = null;

export function voiceEngine(): VoiceEngine {
  return (engine ??= createFakeVoiceEngine());
}

export function setVoiceEngine(next: VoiceEngine | null): void {
  engine = next;
}
