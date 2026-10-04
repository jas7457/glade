/**
 * Meter: a thin horizontal fill bar for "how much of something is used" (I-196: memory of the
 * loaded local models vs the GPU budget). Same look as the usage bars (I-057). Over 100% it
 * stays full in the danger tone.
 *
 *   <Meter label="Memory" percent={42} tone="normal" />
 */
import { cn } from "@glade/app-core/lib/cn";

export type MeterTone = "normal" | "warning" | "critical";

const FILL: Record<MeterTone, string> = {
  normal: "bg-accent",
  warning: "bg-warning",
  critical: "bg-danger",
};

export interface MeterProps {
  /** Accessible name. */
  label: string;
  /** 0-100 (clamped). */
  percent: number;
  tone?: MeterTone;
  class?: string;
}

export function Meter({ label, percent, tone = "normal", class: className }: MeterProps) {
  const pct = Math.min(100, Math.max(0, percent));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      class={cn("h-1.5 overflow-hidden rounded-full bg-fg/10", className)}
    >
      {pct > 0 && <div class={cn("h-full rounded-full", FILL[tone])} style={{ width: `${Math.max(pct, 2)}%` }} />}
    </div>
  );
}
