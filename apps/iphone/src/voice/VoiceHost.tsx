/**
 * Hosts conversation mode's view at the app's root (I-180; see voice-mode.ts), titled after the
 * chat it talks to.
 */
import { sessionsById, workspacesById } from "@glade/app-core/state/store";
import { voiceEngine } from "./engine-provider";
import { closeVoiceMode, voiceMode } from "./voice-mode";
import { VoiceView } from "./VoiceView";

export function VoiceHost() {
  const mode = voiceMode.value;
  if (!mode) return null;
  const session = mode.sessionId ? sessionsById.value.get(mode.sessionId) : undefined;
  const title = session ? (workspacesById.value.get(session.workspaceId)?.title ?? "Chat") : "New Chat";
  return <VoiceView conversation={mode.conversation} engine={voiceEngine()} title={title} onClose={closeVoiceMode} />;
}
