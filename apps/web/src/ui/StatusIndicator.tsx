/**
 * Chat status glyph for list rows and headers. Always occupies the same box (even when idle)
 * so titles never shift as the status changes.
 *
 *   idle     → nothing (space reserved)
 *   working  → spinner                         "Working…"
 *   unread   → accent dot (red if `failed`)    "New messages" / "Last run failed"
 *   blocked  → amber "!" badge                  "Needs your input"
 */
import type { ChatStatus } from "@pi-ui/protocol";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";

export interface StatusIndicatorProps {
  status: ChatStatus;
  /** The last run failed (unread/idle render in the danger colour). */
  failed?: boolean;
  /** Box size in px (default 14). */
  size?: number;
  /** Show a tooltip with the status text (default true). */
  tooltip?: boolean;
  class?: string;
}

export function statusLabel(status: ChatStatus, failed?: boolean): string | null {
  switch (status) {
    case "working":
      return "Working…";
    case "blocked":
      return "Needs your input";
    case "unread":
      return failed ? "Last run failed" : "New messages";
    case "idle":
      return failed ? "Last run failed" : null;
  }
}

export function StatusIndicator({ status, failed, size = 14, tooltip = true, class: className }: StatusIndicatorProps) {
  const label = statusLabel(status, failed);
  // A failed-but-read chat stays quiet: only surface the failure while it's unread.
  const glyph =
    status === "working" ? (
      <Spinner size={size - 2} />
    ) : status === "blocked" ? (
      <span class="flex size-[13px] items-center justify-center rounded-full bg-warning text-[9px] leading-none font-bold text-white">
        !
      </span>
    ) : status === "unread" ? (
      <span class={cn("size-2 rounded-full", failed ? "bg-danger" : "bg-accent")} />
    ) : null;

  const box = (
    <span
      role={label && glyph ? "img" : undefined}
      aria-label={glyph ? (label ?? undefined) : undefined}
      aria-hidden={glyph ? undefined : true}
      data-status={status}
      style={{ width: `${size}px`, height: `${size}px` }}
      class={cn("inline-flex shrink-0 items-center justify-center", className)}
    >
      {glyph}
    </span>
  );
  return tooltip && glyph && label ? <Tooltip content={label}>{box}</Tooltip> : box;
}
