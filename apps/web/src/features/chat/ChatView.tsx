/**
 * Existing chat screen pieces:
 *   - <ChatPane sessionId>: one session's scrolling transcript + composer pinned at the bottom.
 *     The workspace layout (features/workspace, I-036) puts one in each tab group.
 *   - <ChatView workspaceId sessionId>: header + one pane (a single session, no tabs).
 */
import type { ComponentChildren } from "preact";
import { useChatSession } from "@glade/app-core/state/chat-session";
import { workspacesById } from "@glade/app-core/state/store";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "@glade/app-core/features/chat/Composer";
import { Transcript, columnClass } from "@glade/app-core/features/chat/Transcript";

/**
 * `autoFocus` (default true): focus the composer when the pane mounts. `aboveComposer`: shown
 * between the transcript and the composer (the workspace's sub-agent strip, I-080).
 */
export function ChatPane({ sessionId, autoFocus = true, aboveComposer }: { sessionId: string; autoFocus?: boolean; aboveComposer?: ComponentChildren }) {
  // Marks the session as viewed (so finished runs don't turn unread) and loads it.
  useChatSession(sessionId);
  return (
    <div class="flex h-full min-h-0 flex-col bg-window">
      <Transcript chatId={sessionId} />
      <div class={`${columnClass} shrink-0 pb-4`}>
        {aboveComposer}
        <Composer chatId={sessionId} autoFocus={autoFocus} />
      </div>
    </div>
  );
}

export function ChatView({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const workspace = workspacesById.value.get(workspaceId);
  return (
    <div class="flex h-full min-h-0 flex-col bg-window">
      <ChatHeader workspace={workspace} sessionId={sessionId} />
      <div class="min-h-0 flex-1">
        <ChatPane key={sessionId} sessionId={sessionId} />
      </div>
    </div>
  );
}
