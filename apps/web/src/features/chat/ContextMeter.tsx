/**
 * Context meter (I-014): a small ring in the composer toolbar showing how full the model's
 * context window is, with details in a tooltip. Amber above 80%, red above 95%; a dashed ring
 * when the size is unknown (right after compaction, until the next reply).
 */
import type { SessionState } from "@pi-ui/protocol";
import { cn } from "@/lib/cn";
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
  const costText = formatCost(cost);
  const summary = describeUsage(usage);

  return (
    <Tooltip
      side="top"
      content={
        <div class="flex max-w-[260px] flex-col gap-0.5 py-0.5" data-testid="context-meter-details">
          <div class="font-medium">Context: {summary}</div>
          {compacting ? (
            <div class="text-fg-muted">Compacting…</div>
          ) : !known ? (
            <div class="text-fg-muted">Updates after the next reply</div>
          ) : null}
          <div class="text-fg-muted">pi compacts automatically near the limit — type /compact to do it now</div>
          {costText && <div class="text-fg-muted">Session cost: {costText}</div>}
        </div>
      }
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
