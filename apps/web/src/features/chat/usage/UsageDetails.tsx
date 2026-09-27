/**
 * Body of the chat's usage popover (I-057): a context-window bar, the session cost, then the
 * subscription limits that apply to the chat's model (already filtered by the caller with
 * `limitsForModel`) and when they were last updated.
 */
import type { ModelRef, UsageLimits } from "@glade/protocol";
import { formatUpdatedAgo } from "@/state/usage";
import { type ContextUsage, formatCost, formatTokens, meterLevel, usagePercent } from "../context-meter";
import { LimitList, UsageBar } from "./UsageBars";

export interface UsageDetailsProps {
  usage: ContextUsage;
  cost?: number;
  compacting?: boolean;
  /** Limits for the chat's model, or `null` (none / other provider). */
  limits: UsageLimits | null;
  model?: ModelRef | null;
  now?: number;
}

export function UsageDetails({ usage, cost, compacting, limits, model, now = Date.now() }: UsageDetailsProps) {
  const percent = usagePercent(usage);
  const known = percent !== null && usage.tokens !== null;
  const costText = formatCost(cost);
  const window = formatTokens(usage.contextWindow);
  const caption = compacting
    ? "Compacting…"
    : known
      ? `${formatTokens(usage.tokens!)} / ${window} tokens`
      : `? / ${window} tokens · updates after the next reply`;

  return (
    <div class="flex flex-col gap-3" data-testid="context-meter-details">
      <ul class="flex flex-col gap-3">
        <UsageBar
          id="context"
          label="Context"
          ariaLabel="Context window"
          value={known ? `${percent < 1 && percent > 0 ? "<1" : Math.round(percent)}%` : "–"}
          percent={known ? percent : null}
          tone={meterLevel(percent)}
          caption={caption}
        />
      </ul>
      {costText && (
        <div class="flex items-baseline justify-between gap-3">
          <span class="font-medium">Session cost</span>
          <span class="text-[0.85rem] text-fg-muted tabular-nums">{costText}</span>
        </div>
      )}
      {limits && limits.limits.length > 0 && (
        <>
          <div class="flex flex-col gap-3 border-t border-separator pt-3">
            <div class="text-[0.85rem] font-semibold text-fg-muted">{limits.source}</div>
            <LimitList limits={limits.limits} model={model} now={now} />
          </div>
          <div class="text-[0.85rem] text-fg-subtle">
            {formatUpdatedAgo(limits.fetchedAt, now)}
            {limits.stale && " · may be out of date"}
          </div>
        </>
      )}
    </div>
  );
}
