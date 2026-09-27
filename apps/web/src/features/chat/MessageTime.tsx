/**
 * Message times in the transcript (I-111): the small time next to a user bubble / above an agent
 * reply, shown while the message is hovered (the message sets `group/msg`), with the full date
 * and time as its tooltip; and the thin day divider between messages of different days.
 * Formatting lives in message-time.ts.
 *
 * Both are marked `data-aux` so jump-to-message (which counts one column child per render item)
 * skips them.
 */
import { cn } from "@/lib/cn";
import { formatMessageDateTime, formatMessageTime } from "./message-time";

export function MessageTime({ timestamp, class: className }: { timestamp: number; class?: string }) {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  return (
    <time
      data-aux="time"
      dateTime={new Date(timestamp).toISOString()}
      title={formatMessageDateTime(timestamp)}
      class={cn(
        "text-[0.8rem] leading-4 whitespace-nowrap text-fg-subtle tabular-nums select-none",
        "opacity-0 transition-opacity duration-100 group-hover/msg:opacity-100 focus-visible:opacity-100",
        className,
      )}
    >
      {formatMessageTime(timestamp)}
    </time>
  );
}

export function DayDivider({ label }: { label: string }) {
  return (
    <div data-aux="day" role="separator" aria-label={label} class="mt-6 -mb-2 flex items-center gap-3 text-[0.85rem] font-medium text-fg-subtle select-none first:mt-0">
      <div class="h-px flex-1 bg-separator" />
      <span>{label}</span>
      <div class="h-px flex-1 bg-separator" />
    </div>
  );
}
