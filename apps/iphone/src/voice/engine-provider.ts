/**
 * The app's one `VoiceEngine` (I-180): the native one inside the iOS app (native-engine.ts), the
 * fake one elsewhere (fake-engine.ts: speaks on a timer, "hears" what's typed into the voice view's
 * debug field).
 *
 * Tests install their own with `setVoiceEngine()`.
 */
import type { VoiceEngine } from "./engine";
import { getVoiceEngine } from "./native-engine";

let engine: VoiceEngine | null = null;

export function voiceEngine(): VoiceEngine {
  return (engine ??= getVoiceEngine());
}

export function setVoiceEngine(next: VoiceEngine | null): void {
  engine = next;
}
