/**
 * A sub-agent's task and its parent's later messages (I-109; recognized in delegated.ts), shown
 * as a full-width card in the sub-agent's colour instead of a right-aligned user bubble:
 * "Task from main · <parent chat>", the body as Markdown clamped to a few lines ("Show full
 * task" / "Show less"), the time on hover and a copy button.
 */
import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { Check, ClipboardList, Copy, MessageSquare } from "lucide-preact";
import type { AgentColor } from "@glade/protocol";
import { Clamp, IconButton } from "@/ui";
import { Markdown } from "./Markdown";
import { MessageTime } from "./MessageTime";
import type { DelegatedMessage } from "./delegated";
import "./chat.css";

export interface DelegatedCardProps {
  message: DelegatedMessage;
  timestamp: number;
  /** The parent chat's title, when known. */
  parentTitle: string | null;
  /** The sub-agent's colour (the card's accent). */
  color: AgentColor | null;
}

export const DelegatedCard = memo(function DelegatedCard({ message, timestamp, parentTitle, color }: DelegatedCardProps) {
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
        <span class="min-w-0 flex-1 truncate text-fg-muted select-none">
          {task ? "Task from " : "Message from "}
          <span class="font-medium text-fg-strong">main</span>
          {parentTitle && <span class="text-fg-subtle"> · {parentTitle}</span>}
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
