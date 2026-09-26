/**
 * A list of chat rows that shows the first `limit` and a "Show more" / "Show less" toggle.
 * The selected chat is always visible (the list expands if it's beyond the limit).
 */
import { useState } from "preact/hooks";
import type { ChatSummary } from "@pi-ui/protocol";
import { cn } from "@/lib/cn";
import { SidebarList, sidebarClass, type SidebarIndent } from "@/ui";
import { ChatRow } from "./ChatRow";

export interface ChatListProps {
  chats: ChatSummary[];
  selectedChatId: string | null;
  limit: number;
  indent?: SidebarIndent;
  emptyLabel?: string;
  onRemoved?: (chat: ChatSummary) => void;
}

/** How many chats to render: all when expanded or the selection is past the limit. */
export function visibleChatCount(chats: ChatSummary[], limit: number, expanded: boolean, selectedChatId: string | null): number {
  if (expanded) return chats.length;
  const selectedIdx = selectedChatId ? chats.findIndex((c) => c.id === selectedChatId) : -1;
  return Math.min(chats.length, Math.max(limit, selectedIdx + 1));
}

export function ChatList({ chats, selectedChatId, limit, indent = 0, emptyLabel, onRemoved }: ChatListProps) {
  const [expanded, setExpanded] = useState(false);
  const count = visibleChatCount(chats, limit, expanded, selectedChatId);
  if (chats.length === 0 && emptyLabel) {
    return <div class={cn("flex items-center text-fg-subtle", sidebarClass.row, sidebarClass.labelInset[indent])}>{emptyLabel}</div>;
  }
  return (
    <SidebarList role="list">
      {chats.slice(0, count).map((chat) => (
        <div role="listitem" key={chat.id}>
          <ChatRow chat={chat} selected={chat.id === selectedChatId} indent={indent} onRemoved={onRemoved} />
        </div>
      ))}
      {chats.length > limit && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          class={cn("flex h-6 items-center rounded-[6px] text-left text-[0.92rem] text-fg-muted hover:text-fg", sidebarClass.labelInset[indent])}
        >
          {expanded ? "Show less" : `Show more (${chats.length - count})`}
        </button>
      )}
    </SidebarList>
  );
}
