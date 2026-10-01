/**
 * Whether conversation mode is open, and for which chat (I-180). The voice view is hosted at the
 * app's root (VoiceHost), over whatever screen is showing, so a conversation started on New Chat
 * keeps going when the new chat replaces that screen.
 *
 *   openVoiceMode({ kind: "chat", sessionId, title })
 *   openVoiceMode({ kind: "new", start: (text) => startRef.current?.(text) ?? Promise.resolve(null) })
 *
 * Minimized (I-193): the view steps aside and the conversation goes on (listening, reading, the
 * screen kept awake); a small pill over the chat opens it again or ends it. While it reads, the
 * word is highlighted in the chat's transcript too (app-core's `readingHighlight`).
 */
import { effect, signal } from "@preact/signals";
import { readingHighlight } from "@glade/app-core/state/reading-highlight";
import { chatHighlightOf, sameHighlight } from "./chat-highlight";
import { Conversation, chatVoiceBridge, newChatVoiceBridge } from "./conversation";
import { voiceEngine } from "./engine-provider";
import { pauseBeforeSending, resolveVoice, speakingRate, voiceChoice } from "./settings";
import type { VoiceInfo } from "./engine";

export type VoiceTarget = { kind: "chat"; sessionId: string } | { kind: "new"; start: (text: string) => Promise<string | null> };

export interface VoiceMode {
  conversation: Conversation;
  /** The chat's session id (New Chat: set once its first message created it). */
  sessionId: string | null;
  /** The view is minimized: the conversation goes on, the chat shows (with a pill). */
  minimized?: boolean;
}

export const voiceMode = signal<VoiceMode | null>(null);

/** Installed voices, loaded once per app run (for the automatic choice). */
let voices: VoiceInfo[] | null = null;
/** Stops publishing the conversation's word to the chat. */
let stopHighlight: (() => void) | null = null;

export function openVoiceMode(target: VoiceTarget): void {
  const current = voiceMode.value;
  // The voice button of the chat a minimized conversation talks to: bring it back.
  if (current?.minimized && target.kind === "chat" && current.sessionId === target.sessionId) return restoreVoiceMode();
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
    endSilenceMs: () => pauseBeforeSending.value,
    voice: () => ({ voiceId: resolveVoice(voices ?? [], voiceChoice.value)?.id ?? voiceChoice.value ?? undefined, rate: speakingRate.value }),
  });
  voiceMode.value = { conversation, sessionId: target.kind === "chat" ? target.sessionId : null };
  stopHighlight = effect(() => {
    const next = chatHighlightOf(conversation.state.value);
    if (!sameHighlight(readingHighlight.peek(), next)) readingHighlight.value = next;
  });
  conversation.start();
}

/** Hides the view; the conversation goes on. The chat scrolls to the word being read. */
export function minimizeVoiceMode(): void {
  const current = voiceMode.value;
  if (!current || current.minimized) return;
  voiceMode.value = { ...current, minimized: true };
  requestAnimationFrame(() => document.querySelector("mark[data-reading]")?.scrollIntoView?.({ block: "center" }));
}

export function restoreVoiceMode(): void {
  const current = voiceMode.value;
  if (current?.minimized) voiceMode.value = { ...current, minimized: false };
}

export function closeVoiceMode(): void {
  const current = voiceMode.value;
  if (!current) return;
  voiceMode.value = null;
  stopHighlight?.();
  stopHighlight = null;
  readingHighlight.value = null;
  current.conversation.close();
}
