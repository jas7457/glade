/**
 * Whether conversation mode is open, and for which chat (I-180). The voice view is hosted at the
 * app's root (VoiceHost), over whatever screen is showing, so a conversation started on New Chat
 * keeps going when the new chat replaces that screen.
 *
 *   openVoiceMode({ kind: "chat", sessionId, title })
 *   openVoiceMode({ kind: "new", start: (text) => startRef.current?.(text) ?? Promise.resolve(null) })
 */
import { signal } from "@preact/signals";
import { Conversation, chatVoiceBridge, newChatVoiceBridge } from "./conversation";
import { voiceEngine } from "./engine-provider";
import { resolveVoice, speakingRate, voiceChoice } from "./settings";
import type { VoiceInfo } from "./engine";

export type VoiceTarget = { kind: "chat"; sessionId: string } | { kind: "new"; start: (text: string) => Promise<string | null> };

export interface VoiceMode {
  conversation: Conversation;
  /** The chat's session id (New Chat: set once its first message created it). */
  sessionId: string | null;
}

export const voiceMode = signal<VoiceMode | null>(null);

/** Installed voices, loaded once per app run (for the automatic choice). */
let voices: VoiceInfo[] | null = null;

export function openVoiceMode(target: VoiceTarget): void {
  closeVoiceMode();
  const engine = voiceEngine();
  if (!voices) void engine.listVoices().then((v) => (voices = v)).catch(() => {});
  const bridge =
    target.kind === "chat"
      ? chatVoiceBridge(target.sessionId)
      : newChatVoiceBridge(target.start, (sessionId) => {
          if (voiceMode.value) voiceMode.value = { ...voiceMode.value, sessionId };
        });
  const conversation = new Conversation(engine, bridge, {
    voice: () => ({ voiceId: resolveVoice(voices ?? [], voiceChoice.value)?.id ?? voiceChoice.value ?? undefined, rate: speakingRate.value }),
  });
  voiceMode.value = { conversation, sessionId: target.kind === "chat" ? target.sessionId : null };
  conversation.start();
}

export function closeVoiceMode(): void {
  const current = voiceMode.value;
  if (!current) return;
  voiceMode.value = null;
  current.conversation.close();
}
