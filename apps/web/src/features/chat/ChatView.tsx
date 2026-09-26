/**
 * Existing chat screen: header, scrolling transcript and the composer pinned at the bottom.
 * Shows one session of a workspace (until tabs exist (I-036), its active/first main session).
 */
import { useChatSession } from "@/state/chat-session";
import { workspacesById } from "@/state/store";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { Transcript, columnClass } from "./Transcript";

export function ChatView({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  // Marks the session as viewed (so finished runs don't turn unread) and loads it.
  useChatSession(sessionId);
  const workspace = workspacesById.value.get(workspaceId);

  return (
    <div class="flex h-full min-h-0 flex-col bg-window">
      <ChatHeader workspace={workspace} sessionId={sessionId} />
      <Transcript chatId={sessionId} />
      <div class={`${columnClass} shrink-0 pb-4`}>
        <Composer chatId={sessionId} />
      </div>
    </div>
  );
}
