/**
 * The waveform button next to Send in the touch composer (I-180): opens conversation mode.
 */
import { AudioLines } from "lucide-preact";

export function VoiceButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label="Voice mode"
      disabled={disabled}
      onClick={onClick}
      class="m-[9px] mr-0 flex size-10 shrink-0 touch-manipulation items-center justify-center rounded-full bg-fg/8 text-fg select-none active:opacity-60 disabled:opacity-40"
    >
      <AudioLines size={20} strokeWidth={2.25} />
    </button>
  );
}
