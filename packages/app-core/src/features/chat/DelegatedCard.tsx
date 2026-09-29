/**
 * A sub-agent's task and its parent's later messages (I-109; recognized in delegated.ts), shown
 * as a full-width card in the sub-agent's colour instead of a right-aligned user bubble:
 * "Task from main in “<parent chat>”" (the title opens that chat, with the full title as its
 * tooltip, I-146), the body as Markdown clamped to a few lines ("Show full
 * task" / "Show less"), the time on hover and a copy button.
 */
import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { Check, ClipboardList, Copy, MessageSquare } from "lucide-preact";
import type { AgentColor } from "@glade/protocol";
import { sessions } from "@glade/app-core/state/store";
import { requestOpenChat } from "@glade/app-core/state/open-chat";
import { cn } from "@glade/app-core/lib/cn";
import { Clamp, IconButton, Tooltip } from "@glade/app-core/ui";
import { Markdown } from "./Markdown";
import { MessageTime } from "./MessageTime";
import type { DelegatedMessage } from "./delegated";
import "./chat.css";

export interface DelegatedCardProps {
  message: DelegatedMessage;
  timestamp: number;
  /** The parent chat's title, when known. */
  parentTitle: string | null;
  /** The parent chat's session id (clicking its title opens it, I-146). */
  parentId?: string | null;
  /** The sub-agent's colour (the card's accent). */
  color: AgentColor | null;
}

export const DelegatedCard = memo(function DelegatedCard({ message, timestamp, parentTitle, parentId, color }: DelegatedCardProps) {
  const [copied, setCopied] = useState(false);
  const task = message.kind === "task";
  const Icon = task ? ClipboardList : MessageSquare;
  const copy = () => {
    void navigator.clipboard?.writeText(message.body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div
      class="group/msg mt-6 overflow-hidden rounded-[10px] border-[0.5px] border-separator bg-surface shadow-[inset_3px_0_0_var(--pi-agent)] first:mt-0"
      data-role="delegated"
      data-kind={message.kind}
      data-agent-color={color ?? undefined}
    >
      <div class="flex h-8 items-center gap-2 pr-1.5 pl-3">
        <span class="pi-tone-icon" data-tone="task" style={{ "--pi-tone": "var(--pi-agent)" }} aria-hidden="true">
          <Icon size={12} strokeWidth={2.25} />
        </span>
        <span class="flex min-w-0 flex-1 items-baseline text-fg-muted select-none">
          <span class="shrink-0 whitespace-pre">
            {task ? "Task from " : "Message from "}
            <span class="font-medium text-fg-strong">main</span>
            {parentTitle ? " in " : ""}
          </span>
          {parentTitle && <ParentChatLink title={parentTitle} parentId={parentId ?? null} />}
        </span>
        <MessageTime timestamp={timestamp} />
        {message.body && (
          <IconButton label={copied ? "Copied" : task ? "Copy task" : "Copy message"} size="sm" onClick={copy}>
            {copied ? <Check /> : <Copy />}
          </IconButton>
        )}
      </div>
      <div class="border-t-[0.5px] border-separator px-3.5 pt-2 pb-2.5">
        {message.body ? (
          <Clamp lines={task ? 3 : 6} lineHeight={1.6} moreLabel={task ? "Show full task" : "Show more"} lessLabel="Show less">
            <Markdown text={message.body} />
          </Clamp>
        ) : (
          <div class="text-fg-subtle italic">(empty)</div>
        )}
      </div>
    </div>
  );
});

/** The parent chat's title: truncated, full title in a tooltip, click opens that chat (I-146). */
function ParentChatLink({ title, parentId }: { title: string; parentId: string | null }) {
  const parent = parentId ? sessions.value.find((s) => s.id === parentId) : undefined;
  const open = parent ? () => requestOpenChat({ workspaceId: parent.workspaceId, sessionId: parent.id, sessionKind: parent.kind }) : undefined;
  const label = `From the chat “${title}”`;
  const text = "min-w-0 truncate text-fg-subtle";
  return (
    <Tooltip content={open ? `${label} · click to open it` : label}>
      {open ? (
        <button type="button" data-role="parent-chat" aria-label={`Open the chat “${title}”`} onClick={open} class={cn(text, "text-left outline-none hover:text-fg hover:underline focus-visible:underline")}>
          “{title}”
        </button>
      ) : (
        <span data-role="parent-chat" tabIndex={0} aria-label={label} class={cn(text, "outline-none")}>
          “{title}”
        </span>
      )}
    </Tooltip>
  );
}
