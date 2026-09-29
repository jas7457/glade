/**
 * StatusDot: a small coloured dot that says at a glance how something is doing (I-142: remote
 * connections). The text stays next to it (label) and as its tooltip/accessible name.
 *
 *   on       → green   connected
 *   pending  → amber   connecting / reconnecting
 *   off      → grey    turned off / offline
 *   error    → red     needs attention (needs pairing, can't reach)
 *
 *   <StatusDot tone="on" label="Connected" />
 */
import { cn } from "@/lib/cn";

export type StatusTone = "on" | "pending" | "off" | "error";

const TONE_CLASS: Record<StatusTone, string> = {
  on: "bg-success",
  pending: "bg-warning",
  off: "bg-fg-subtle",
  error: "bg-danger",
};

export interface StatusDotProps {
  tone: StatusTone;
  /** What it means ("Connected"): the tooltip and accessible name; omit when the text is right next to it. */
  label?: string;
  /** Diameter in px (default 6). */
  size?: number;
  class?: string;
}

export function StatusDot({ tone, label, size = 6, class: className }: StatusDotProps) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={label}
      data-status-dot={tone}
      style={{ width: `${size}px`, height: `${size}px` }}
      class={cn("inline-block shrink-0 rounded-full", TONE_CLASS[tone], className)}
    />
  );
}
