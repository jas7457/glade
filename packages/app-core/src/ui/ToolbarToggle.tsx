/**
 * Toolbar toggle button: an icon plus an optional count (e.g. the chat header's changes button,
 * I-097: "📄 3"). Same look as IconButton, but grows to fit the count; `pressed` = on.
 *
 *   <ToolbarToggle icon={<FileDiff />} count={3} pressed={open} label="3 changed files"
 *                  tooltip="Show Changes" onClick={toggle} />
 */
import type { ComponentChildren } from "preact";
import { cn } from "@glade/app-core/lib/cn";
import { Tooltip } from "./Tooltip";

export interface ToolbarToggleProps {
  icon: ComponentChildren;
  /** Shown after the icon when > 0. */
  count?: number | null;
  pressed: boolean;
  /** Accessible label. */
  label: string;
  /** Tooltip text (default: `label`). */
  tooltip?: string;
  onClick: () => void;
  disabled?: boolean;
}

export function ToolbarToggle({ icon, count, pressed, label, tooltip, onClick, disabled }: ToolbarToggleProps) {
  return (
    <Tooltip content={tooltip ?? label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        class={cn(
          "inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-control px-1.5 text-fg-muted hover:bg-hover hover:text-fg active:bg-selected disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4",
          pressed && "bg-selected text-fg",
        )}
      >
        {icon}
        {count ? <span class="text-[0.92rem] font-medium tabular-nums">{count}</span> : null}
      </button>
    </Tooltip>
  );
}
