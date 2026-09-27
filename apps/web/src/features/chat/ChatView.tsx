/**
 * Existing chat screen pieces:
 *   - <ChatPane sessionId>: one session's scrolling transcript + composer pinned at the bottom.
 *     The workspace layout (features/workspace, I-036) puts one in each tab group.
 *   - <ChatView workspaceId sessionId>: header + one pane (a single session, no tabs).
 */
import { useChatSession } from "@/state/chat-session";
import { workspacesById } from "@/state/store";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { Transcript, columnClass } from "./Transcript";

/** `autoFocus` (default true): focus the composer when the pane mounts. */
export function ChatPane({ sessionId, autoFocus = true }: { sessionId: string; autoFocus?: boolean }) {
  // Marks the session as viewed (so finished runs don't turn unread) and loads it.
  useChatSession(sessionId);
  return (
    <div class="flex h-full min-h-0 flex-col bg-window">
      <Transcript chatId={sessionId} />
      <div class={`${columnClass} shrink-0 pb-4`}>
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
