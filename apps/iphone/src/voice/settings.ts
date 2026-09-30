/**
 * Conversation mode settings (I-180), stored on the phone (localStorage, like the theme): the
 * voice replies are read with (null: the best installed one, see `bestVoice`) and the speaking
 * rate (0.5 … 2, 1 = normal).
 */
import { signal } from "@preact/signals";
import type { VoiceInfo, VoiceQuality } from "./engine";

const KEY = "glade.iphone.voice";

interface Stored {
  voiceId: string | null;
  rate: number;
}

export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

function read(): Stored {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Stored>;
    return {
      voiceId: typeof raw.voiceId === "string" ? raw.voiceId : null,
      rate: typeof raw.rate === "number" && raw.rate >= MIN_RATE && raw.rate <= MAX_RATE ? raw.rate : 1,
    };
  } catch {
    return { voiceId: null, rate: 1 };
  }
}

const initial = read();
/** The chosen voice's id; null = automatic (the best installed English voice). */
export const voiceChoice = signal<string | null>(initial.voiceId);
export const speakingRate = signal<number>(initial.rate);

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ voiceId: voiceChoice.value, rate: speakingRate.value } satisfies Stored));
  } catch {
    /* storage unavailable */
  }
}

export function setVoiceChoice(id: string | null): void {
  voiceChoice.value = id;
  save();
}

export function setSpeakingRate(rate: number): void {
  speakingRate.value = Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(rate * 100) / 100));
  save();
}

/** Re-reads storage (tests). */
export function reloadVoiceSettings(): void {
  const s = read();
  voiceChoice.value = s.voiceId;
  speakingRate.value = s.rate;
}

const RANK: Record<VoiceQuality, number> = { premium: 3, enhanced: 2, default: 1 };

/**
 * The best installed voice for `locale` (default English, see `navigatorLocale`): Premium > Enhanced > default, the
 * exact locale before other variants of its language (English when nothing matches). Personal
 * Voices aren't picked automatically.
 */
export function bestVoice(voices: readonly VoiceInfo[], locale: string = navigatorLocale()): VoiceInfo | null {
  const lang = locale.split("-")[0]!.toLowerCase();
  const pool = (l: string) => voices.filter((v) => !v.personal && v.language.toLowerCase().split("-")[0] === l);
  const candidates = pool(lang).length ? pool(lang) : pool("en");
  if (candidates.length === 0) return null;
  const score = (v: VoiceInfo) => RANK[v.quality] * 10 + (v.language.toLowerCase() === locale.toLowerCase() ? 1 : 0);
  return [...candidates].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0]!;
}

/** The voice replies use: the chosen one if it's still installed, else the best one. */
export function resolveVoice(voices: readonly VoiceInfo[], choice: string | null = voiceChoice.value): VoiceInfo | null {
  return (choice ? voices.find((v) => v.id === choice) : undefined) ?? bestVoice(voices);
}

/** Replies are read in English: the device's English variant (en-GB…), else en-US. */
function navigatorLocale(): string {
  const l = (typeof navigator !== "undefined" && navigator.language) || "";
  return l.toLowerCase().startsWith("en") ? l : "en-US";
}

/** Voices grouped by quality for the picker (best first), `language` = the device's language only unless `all`. */
export function groupVoices(voices: readonly VoiceInfo[], locale: string = navigatorLocale(), all = false): Array<{ quality: VoiceQuality; voices: VoiceInfo[] }> {
  const lang = locale.split("-")[0]!.toLowerCase();
  const shown = all ? voices : voices.filter((v) => v.language.toLowerCase().split("-")[0] === lang || v.language.toLowerCase().startsWith("en"));
  return (["premium", "enhanced", "default"] as const)
    .map((quality) => ({ quality, voices: shown.filter((v) => v.quality === quality).sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language)) }))
    .filter((g) => g.voices.length > 0);
}
