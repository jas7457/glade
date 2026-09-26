/**
 * Context meter (I-014): a small ring in the composer toolbar showing how full the model's
 * context window is, with details in a tooltip. Amber above 80%, red above 95%; a dashed ring
 * when the size is unknown (right after compaction, until the next reply). The tooltip also
 * lists the subscription limits (I-032) when `usageLimits` is available.
 */
import type { SessionState, UsageLimit, UsageLimits } from "@pi-ui/protocol";
import { cn } from "@/lib/cn";
import { formatPercent, formatResetsAt, usageLimits } from "@/state/usage";
import { Tooltip } from "@/ui";
import { describeUsage, formatCost, meterLevel, usagePercent } from "./context-meter";

const SIZE = 16;
const STROKE = 2;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

const levelClass = { normal: "text-fg-muted", warning: "text-warning", critical: "text-danger" } as const;

export interface ContextMeterProps {
  usage: SessionState["contextUsage"];
  cost?: number;
  compacting?: boolean;
}

export function ContextMeter({ usage, cost, compacting }: ContextMeterProps) {
  if (!usage) return null;
  const percent = usagePercent(usage);
  const known = percent !== null && usage.tokens !== null;
  const level = meterLevel(percent);
  const filled = known ? Math.min(100, percent) / 100 : 0;
  const summary = describeUsage(usage);

  return (
    <Tooltip
      side="top"
      content={<ContextMeterDetails usage={usage} cost={cost} compacting={compacting} limits={usageLimits.value} />}
    >
      <button
        type="button"
        aria-label={`Context usage: ${summary}`}
        data-level={known ? level : "unknown"}
        class={cn("inline-flex size-6 items-center justify-center rounded-control hover:bg-hover", levelClass[level])}
      >
        <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" class={cn(compacting && "animate-pulse")}>
          <circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            stroke-width={STROKE}
            opacity={known ? 0.25 : 0.6}
            stroke-dasharray={known ? undefined : "2 2.4"}
          />
          {known && filled > 0 && (
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              stroke-width={STROKE}
              stroke-linecap="round"
              stroke-dasharray={`${Math.max(filled * CIRCUMFERENCE, 1.5)} ${CIRCUMFERENCE}`}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            />
          )}
        </svg>
      </button>
    </Tooltip>
  );
}

/** The tooltip body; exported for tests (Radix tooltips don't open in jsdom). */
export function ContextMeterDetails({
  usage,
  cost,
  compacting,
  limits,
}: ContextMeterProps & { usage: NonNullable<ContextMeterProps["usage"]>; limits: UsageLimits | null }) {
  const percent = usagePercent(usage);
  const known = percent !== null && usage.tokens !== null;
  const costText = formatCost(cost);
  return (
    <div class="flex max-w-[260px] flex-col gap-0.5 py-0.5" data-testid="context-meter-details">
      <div class="font-medium">Context: {describeUsage(usage)}</div>
      {compacting ? (
        <div class="text-fg-muted">Compacting…</div>
      ) : !known ? (
        <div class="text-fg-muted">Updates after the next reply</div>
      ) : null}
      {costText && <div class="text-fg-muted">Session cost: {costText}</div>}
      {limits && limits.limits.length > 0 && <LimitLines usage={limits} />}
    </div>
  );
}

const limitTone: Record<UsageLimit["severity"], string> = {
  normal: "text-fg-muted",
  warning: "text-warning",
  critical: "text-danger",
};

/** "Current session 52% · resets at 6:40 PM", one line per limit, coloured by severity. */
export function LimitLines({ usage, now = Date.now() }: { usage: UsageLimits; now?: number }) {
  return (
    <div class="mt-1 flex flex-col gap-0.5 border-t border-separator pt-1" data-testid="context-meter-limits">
      <div class="font-medium">
        {usage.source}
        {usage.stale && <span class="font-normal text-fg-muted"> · may be out of date</span>}
      </div>
      {usage.limits.map((limit) => {
        const resets = formatResetsAt(limit.resetsAt, now);
        return (
          <div key={limit.id} data-limit-id={limit.id} class={cn("tabular-nums", limitTone[limit.severity])}>
            {limit.label} {formatPercent(limit.percent)}
            {resets && ` · ${resets.charAt(0).toLowerCase()}${resets.slice(1)}`}
          </div>
        );
      })}
    </div>
  );
}
