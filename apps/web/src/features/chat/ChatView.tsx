/**
 * Existing chat screen: header, scrolling transcript and the composer pinned at the bottom.
 */
import { chatsById } from "@/state/store";
import { useChatSession } from "@/state/chat-session";
import { ChatHeader } from "./ChatHeader";
import { Composer } from "./Composer";
import { Transcript, columnClass } from "./Transcript";

export function ChatView({ chatId }: { chatId: string }) {
  // Marks the chat as viewed (so finished runs don't turn unread) and loads it.
  useChatSession(chatId);
  const chat = chatsById.value.get(chatId);

  return (
    <div class="flex h-full min-h-0 flex-col bg-window">
      <ChatHeader chat={chat} chatId={chatId} />
      <Transcript chatId={chatId} />
      <div class={`${columnClass} shrink-0 pb-4`}>
        <Composer chatId={chatId} />
      </div>
    </div>
  );
}
