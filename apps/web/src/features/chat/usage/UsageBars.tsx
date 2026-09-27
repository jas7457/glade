/**
 * Labelled usage bars for the chat's usage popover (I-057; moved from the old sidebar gauge,
 * I-015): a generic {@link UsageBar} (label, value, thin progress bar, caption) coloured by
 * severity, and {@link LimitList} rendering subscription limits with it.
 */
import type { ComponentChildren } from "preact";
import type { ModelRef, UsageLimit } from "@glade/protocol";
import { cn } from "@/lib/cn";
import { formatPercent, formatResetsAt, limitMatchesModel } from "@/state/usage";

export type UsageTone = UsageLimit["severity"];

const toneText: Record<UsageTone, string> = {
  normal: "text-fg-muted",
  warning: "text-warning",
  critical: "text-danger",
};
const toneFill: Record<UsageTone, string> = {
  normal: "bg-accent",
  warning: "bg-warning",
  critical: "bg-danger",
};

export interface UsageBarProps {
  label: ComponentChildren;
  /** Accessible name of the progress bar (the label may contain markup). */
  ariaLabel: string;
  /** Right-aligned value, e.g. "52% used". */
  value: ComponentChildren;
  /** 0-100, or `null` when unknown (empty track). */
  percent: number | null;
  tone: UsageTone;
  /** Small line under the bar, e.g. "Resets at 6:40 PM". */
  caption?: ComponentChildren;
  dimmed?: boolean;
  id?: string;
}

export function UsageBar({ label, ariaLabel, value, percent, tone, caption, dimmed, id }: UsageBarProps) {
  const pct = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <li data-limit-id={id} class={cn("flex flex-col gap-1", dimmed && "opacity-60")}>
      <div class="flex items-baseline justify-between gap-3">
        <span class="min-w-0 truncate font-medium">{label}</span>
        <span class={cn("shrink-0 text-[0.85rem] tabular-nums", toneText[tone])}>{value}</span>
      </div>
      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(pct)}
        class="h-1.5 overflow-hidden rounded-full bg-fg/10"
      >
        {pct > 0 && <div class={cn("h-full rounded-full", toneFill[tone])} style={{ width: `${Math.max(pct, 2)}%` }} />}
      </div>
      {caption && <div class="text-[0.85rem] text-fg-subtle tabular-nums">{caption}</div>}
    </li>
  );
}

export interface LimitListProps {
  limits: readonly UsageLimit[];
  /** The chat's model: per-model limits for it are tagged, other models' ones dimmed. */
  model?: ModelRef | null;
  now?: number;
}

/** One bar per subscription limit, with "N% used" and the reset time. */
export function LimitList({ limits, model, now = Date.now() }: LimitListProps) {
  return (
    <ul class="flex flex-col gap-3" data-testid="usage-limits">
      {limits.map((limit) => {
        const mine = limitMatchesModel(limit, model);
        return (
          <UsageBar
            key={limit.id}
            id={limit.id}
            ariaLabel={limit.label}
            label={
              <>
                {limit.label}
                {mine && <span class="ml-1.5 text-[0.85rem] font-normal text-accent">· this model</span>}
              </>
            }
            value={`${formatPercent(limit.percent)} used`}
            percent={limit.percent}
            tone={limit.severity}
            caption={formatResetsAt(limit.resetsAt, now)}
            dimmed={!!limit.model && !mine && limit.severity === "normal"}
          />
        );
      })}
    </ul>
  );
}
