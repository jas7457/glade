/**
 * Hosts conversation mode's view at the app's root (I-180; see voice-mode.ts), titled after the
 * chat it talks to. Minimized (I-193), a small pill near the top of the screen (clear of the
 * composer's Send / Stop) shows what it's doing, and opens the view again or ends voice mode.
 */
import { AudioLines, X } from "lucide-preact";
import { sessionsById, workspacesById } from "@glade/app-core/state/store";
import { voiceEngine } from "./engine-provider";
import { closeVoiceMode, minimizeVoiceMode, restoreVoiceMode, voiceMode, type VoiceMode } from "./voice-mode";
import { statusText, VoiceView } from "./VoiceView";

export function VoiceHost() {
  const mode = voiceMode.value;
  if (!mode) return null;
  if (mode.minimized) return <VoicePill mode={mode} />;
  const session = mode.sessionId ? sessionsById.value.get(mode.sessionId) : undefined;
  const title = session ? (workspacesById.value.get(session.workspaceId)?.title ?? "Chat") : "New Chat";
  return <VoiceView conversation={mode.conversation} engine={voiceEngine()} title={title} onClose={closeVoiceMode} onMinimize={minimizeVoiceMode} />;
}

function VoicePill({ mode }: { mode: VoiceMode }) {
  const state = mode.conversation.state.value;
  return (
    <div
      class="fixed left-1/2 z-40 flex w-max -translate-x-1/2 items-center whitespace-nowrap rounded-full bg-surface-raised shadow-[0_4px_16px_-4px_rgb(0_0_0/0.3)] ring-[0.5px] ring-separator animate-[phone-fade_160ms_ease-out]"
      style={{ top: "calc(env(safe-area-inset-top) + 52px)" }}
      data-testid="voice-pill"
    >
      <button type="button" aria-label="Open voice mode" onClick={restoreVoiceMode} class="flex h-10 items-center gap-2 pr-2 pl-3.5 text-[15px] select-none active:opacity-60">
        <AudioLines size={18} class="text-accent" />
        <span class="font-medium text-fg-strong">Voice</span>
        <span class="text-fg-muted">· {statusText(state)}</span>
      </button>
      <button type="button" aria-label="End voice mode" onClick={closeVoiceMode} class="flex size-10 items-center justify-center rounded-full text-fg-muted select-none active:opacity-60">
        <X size={18} />
      </button>
    </div>
  );
}
