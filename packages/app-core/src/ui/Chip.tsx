/**
 * Chip: a compact label with an icon for a file or path (attached files, `@` mentions, I-090 /
 * I-092). Two sizes:
 *   - "md": a standalone token (composer attachments, files on a sent message), optional
 *     remove button and click action;
 *   - "inline": sits inside running text (mentions in a message bubble).
 * The tooltip is the native `title` (cheap in long transcripts, no provider needed).
 */
import type { ComponentChildren } from "preact";
import { X } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";

export interface ChipProps {
  icon?: ComponentChildren;
  label: string;
  /** Tooltip (e.g. the full path). */
  title?: string;
  size?: "md" | "inline";
  onClick?: () => void;
  /** Shows a remove (×) button. */
  onRemove?: () => void;
  /** Accessible label of the remove button (default "Remove <label>"). */
  removeLabel?: string;
  class?: string;
}

export function Chip({ icon, label, title, size = "md", onClick, onRemove, removeLabel, class: className }: ChipProps) {
  const inline = size === "inline";
  const body = (
    <>
      {icon && <span class={cn("flex shrink-0 text-fg-muted", inline ? "[&_svg]:size-[0.95em]" : "[&_svg]:size-3.5")}>{icon}</span>}
      <span class="min-w-0 truncate">{label}</span>
    </>
  );
  const bodyClass = cn(
    "inline-flex min-w-0 items-center",
    inline ? "gap-[0.25em]" : "gap-1.5",
    onClick && "rounded-[inherit] text-left hover:text-fg-strong focus-visible:outline-none",
  );
  return (
    <span
      data-chip={size}
      title={title}
      class={cn(
        "max-w-full min-w-0 items-center border-separator",
        inline
          ? "mx-[0.05em] inline-flex max-w-[28em] rounded-[5px] border-[0.5px] bg-surface-raised px-[0.35em] align-baseline text-[0.92em] leading-[1.35]"
          : "inline-flex h-7 max-w-[260px] gap-1 select-none rounded-[8px] border-[0.5px] bg-surface-raised pr-1.5 pl-2 text-[0.92rem] text-fg shadow-[0_1px_2px_rgb(0_0_0/0.04)]",
        onClick && "hover:bg-hover",
        className,
      )}
    >
      {onClick ? (
        <button type="button" class={bodyClass} onClick={onClick}>
          {body}
        </button>
      ) : (
        <span class={bodyClass}>{body}</span>
      )}
      {onRemove && (
        <button
          type="button"
          aria-label={removeLabel ?? `Remove ${label}`}
          onClick={onRemove}
          class="-mr-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full text-fg-subtle hover:bg-hover hover:text-fg"
        >
          <X size={11} strokeWidth={2.5} />
        </button>
      )}
    </span>
  );
}
