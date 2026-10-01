/**
 * Body of the chat's usage popover (I-057, I-191): a context-window bar, the session cost, then
 * the subscription limits of every agent that reports them, one group per agent (already ordered
 * by the caller with `usageForChat`: the chat's own agent first, tagged "This chat"), each with
 * its plan and when it was last updated.
 */
import type { ModelRef } from "@glade/protocol";
import { formatUpdatedAgo, type ChatUsageEntry } from "@glade/app-core/state/usage";
import { type ContextUsage, formatCost, formatTokens, meterLevel, usagePercent } from "../context-meter";
import { LimitList, UsageBar } from "./UsageBars";

export interface UsageDetailsProps {
  usage: ContextUsage;
  cost?: number;
  compacting?: boolean;
  /** The agents' limits, in display order (empty: none). */
  limits: readonly ChatUsageEntry[];
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
      {limits.map((entry) => (
        <AgentLimits key={entry.harnessId || "default"} entry={entry} model={model} now={now} />
      ))}
    </div>
  );
}

/** One agent's limits: its name (plus "This chat" for the chat's own), plan, bars, update time. */
function AgentLimits({ entry, model, now }: { entry: ChatUsageEntry; model?: ModelRef | null; now: number }) {
  const { usage } = entry;
  return (
    <section class="flex flex-col gap-3 border-t border-separator pt-3" data-testid="usage-agent" data-harness={entry.harnessId} aria-label={`${entry.label} limits`}>
      <div class="flex flex-col">
        <div class="flex items-baseline justify-between gap-3">
          <span class="min-w-0 truncate text-[0.85rem] font-semibold text-fg-muted">{entry.label}</span>
          {entry.mine && <span class="shrink-0 text-[0.85rem] text-accent">This chat</span>}
        </div>
        {usage.source !== entry.label && <span class="truncate text-[0.85rem] text-fg-subtle">{usage.source}</span>}
      </div>
      <LimitList limits={usage.limits} model={entry.mine ? model : null} now={now} />
      <div class="text-[0.85rem] text-fg-subtle">
        {formatUpdatedAgo(usage.fetchedAt, now)}
        {usage.stale && " · may be out of date"}
      </div>
    </section>
  );
}
