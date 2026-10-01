/**
 * Settings → Voice (I-180): the voice replies are read with (installed Apple voices grouped by
 * quality; Automatic = the best installed English one, Premium > Enhanced > default), a Preview,
 * the speaking rate and the pause before what you said is sent (I-193). Stored on the phone (voice/settings.ts).
 */
import { ChevronLeft, Play, Square } from "lucide-preact";
import { useEffect, useState } from "preact/hooks";
import { useNavigate } from "react-router";
import { paths } from "~/app/routes";
import { ListGroup, NavBar, NavIconButton, PhoneButton, Screen, ScreenBody } from "~/ui/phone";
import { CheckRow } from "~/ui/phone-extra";
import type { VoiceInfo, VoiceQuality } from "./engine";
import { voiceEngine } from "./engine-provider";
import {
  bestVoice,
  DEFAULT_PAUSE_MS,
  groupVoices,
  MAX_PAUSE_MS,
  MAX_RATE,
  MIN_PAUSE_MS,
  MIN_RATE,
  PAUSE_STEP_MS,
  pauseBeforeSending,
  resolveVoice,
  setPauseBeforeSending,
  setSpeakingRate,
  setVoiceChoice,
  speakingRate,
  voiceChoice,
} from "./settings";

const QUALITY: Record<VoiceQuality, string> = { premium: "Premium", enhanced: "Enhanced", default: "Standard" };

export const PREVIEW_TEXT = "Hi! This is how I'll read replies to you in voice mode.";

export function VoiceSettingsScreen() {
  const navigate = useNavigate();
  const [voices, setVoices] = useState<VoiceInfo[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => {
    let live = true;
    voiceEngine()
      .listVoices()
      .then((v) => live && setVoices(v))
      .catch(() => live && setVoices([]));
    return () => {
      live = false;
      void voiceEngine().stopSpeaking().catch(() => {});
    };
  }, []);

  const best = voices ? bestVoice(voices) : null;
  const current = voices ? resolveVoice(voices) : null;
  const choice = voiceChoice.value;
  const groups = voices ? groupVoices(voices) : [];

  const preview = (voice: VoiceInfo | null = current) => {
    const engine = voiceEngine();
    setPreviewing(true);
    void engine
      .speak(PREVIEW_TEXT, { voiceId: voice?.id, rate: speakingRate.value }, (e) => {
        if (e.type !== "word") setPreviewing(false);
      })
      .catch(() => setPreviewing(false));
  };
  const pick = (id: string | null) => {
    setVoiceChoice(id);
    preview(id ? (voices?.find((v) => v.id === id) ?? null) : best);
  };

  return (
    <Screen grouped>
      <NavBar
        title="Voice"
        left={
          <NavIconButton label="Back" onClick={() => navigate(paths.settings())}>
            <ChevronLeft size={26} />
          </NavIconButton>
        }
      />
      <ScreenBody class="pt-2">
        <ListGroup header="Speaking Rate" footer="How fast replies are read in voice mode.">
          <div class="flex items-center gap-3 px-4 py-3">
            <span class="text-[13px] text-fg-muted">Slower</span>
            <input
              type="range"
              aria-label="Speaking rate"
              min={MIN_RATE}
              max={MAX_RATE}
              step={0.05}
              value={speakingRate.value}
              onInput={(e) => setSpeakingRate(Number((e.currentTarget as HTMLInputElement).value))}
              class="min-w-0 flex-1 accent-[var(--color-accent)]"
            />
            <span class="text-[13px] text-fg-muted">Faster</span>
          </div>
          <div class="flex items-center justify-between px-4 py-1.5">
            <span class="text-[15px] text-fg-muted" data-testid="rate-value">
              {speakingRate.value.toFixed(2)}×
            </span>
            <PhoneButton kind="plain" block={false} onClick={() => setSpeakingRate(1)}>
              Reset
            </PhoneButton>
          </div>
        </ListGroup>

        <div class="mx-4 mb-6">
          <PhoneButton kind="tinted" onClick={() => (previewing ? void voiceEngine().stopSpeaking() : preview())} disabled={!voices}>
            {previewing ? <Square size={16} fill="currentColor" strokeWidth={0} /> : <Play size={18} fill="currentColor" strokeWidth={0} />}
            {previewing ? "Stop Preview" : "Preview"}
          </PhoneButton>
        </div>

        <ListGroup
          header="Pause Before Sending"
          footer="How long you can pause before what you said is sent. Make it longer if your messages get cut off while you think; shorter for quicker replies."
        >
          <div class="flex items-center gap-3 px-4 py-3">
            <span class="text-[13px] text-fg-muted">Shorter</span>
            <input
              type="range"
              aria-label="Pause before sending"
              min={MIN_PAUSE_MS}
              max={MAX_PAUSE_MS}
              step={PAUSE_STEP_MS}
              value={pauseBeforeSending.value}
              onInput={(e) => setPauseBeforeSending(Number((e.currentTarget as HTMLInputElement).value))}
              class="min-w-0 flex-1 accent-[var(--color-accent)]"
            />
            <span class="text-[13px] text-fg-muted">Longer</span>
          </div>
          <div class="flex items-center justify-between px-4 py-1.5">
            <span class="text-[15px] text-fg-muted" data-testid="pause-value">
              {seconds(pauseBeforeSending.value)}
            </span>
            <PhoneButton kind="plain" block={false} onClick={() => setPauseBeforeSending(DEFAULT_PAUSE_MS)}>
              Reset
            </PhoneButton>
          </div>
        </ListGroup>

        <ListGroup header="Voice" footer="Download better voices in iOS Settings → Accessibility → Spoken Content → Voices. Enhanced and Premium voices sound much more natural.">
          <CheckRow title="Automatic" subtitle={best ? `The best installed voice: ${best.name} (${QUALITY[best.quality]})` : "The best installed voice"} checked={!choice || !current || current.id !== choice} onClick={() => pick(null)} />
        </ListGroup>
        {voices === null && <p class="px-8 text-[15px] text-fg-muted">Loading voices…</p>}
        {voices?.length === 0 && <p class="px-8 text-[15px] text-fg-muted">No voices are installed.</p>}
        {groups.map((g) => (
          <ListGroup key={g.quality} header={QUALITY[g.quality]}>
            {g.voices.map((v) => (
              <CheckRow key={v.id} title={v.name} subtitle={languageName(v.language)} checked={choice === v.id && current?.id === v.id} onClick={() => pick(v.id)} />
            ))}
          </ListGroup>
        ))}
      </ScreenBody>
    </Screen>
  );
}

/** 1600 → "1.6 seconds". */
export function seconds(ms: number): string {
  const s = (ms / 1000).toFixed(1).replace(/\.0$/, "");
  return `${s} ${s === "1" ? "second" : "seconds"}`;
}

function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames([navigator.language || "en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
