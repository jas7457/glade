/**
 * Pure helpers for the context meter (I-014): token/cost formatting and warning thresholds.
 */
import type { SessionState } from "@glade/protocol";

export type ContextUsage = NonNullable<SessionState["contextUsage"]>;
export type MeterLevel = "normal" | "warning" | "critical";

/** Above these percentages the ring turns amber / red. */
export const METER_WARNING_PERCENT = 80;
export const METER_CRITICAL_PERCENT = 95;

/** 950 → "950", 42_130 → "42.1k", 200_000 → "200k", 1_048_576 → "1M". */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  const [value, unit] = abs < 1_000_000 ? [n / 1000, "k"] : [n / 1_000_000, "M"];
  const text = Math.abs(value) >= 100 ? String(Math.round(value)) : String(Number(value.toFixed(1)));
  return `${text}${unit}`;
}

/** "$0.45"; tiny non-zero amounts show as "<$0.01"; `null` for 0 (hidden). */
export function formatCost(cost: number | undefined): string | null {
  if (!cost || !Number.isFinite(cost) || cost <= 0) return null;
  if (cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

/** Percentage of the window in use, or `null` when unknown (right after compaction). */
export function usagePercent(usage: ContextUsage): number | null {
  if (usage.percent !== null && Number.isFinite(usage.percent)) return Math.max(0, usage.percent);
  if (usage.tokens !== null && usage.contextWindow > 0) return Math.max(0, (usage.tokens / usage.contextWindow) * 100);
  return null;
}

export function meterLevel(percent: number | null): MeterLevel {
  if (percent === null) return "normal";
  if (percent > METER_CRITICAL_PERCENT) return "critical";
  if (percent > METER_WARNING_PERCENT) return "warning";
  return "normal";
}

function formatPercent(percent: number): string {
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

/** "42.1k / 200k tokens (21%)", or "? / 200k tokens" when unknown. */
export function describeUsage(usage: ContextUsage): string {
  const percent = usagePercent(usage);
  const window = formatTokens(usage.contextWindow);
  if (usage.tokens === null || percent === null) return `? / ${window} tokens`;
  return `${formatTokens(usage.tokens)} / ${window} tokens (${formatPercent(percent)})`;
}

/** One-line summary for the /stats command. */
export function describeStats(state: Pick<SessionState, "contextUsage" | "sessionStats">): string {
  const parts: string[] = [];
  if (state.contextUsage) parts.push(`Context ${describeUsage(state.contextUsage)}`);
  const stats = state.sessionStats;
  if (stats) {
    const t = stats.tokens;
    parts.push(
      `Session ${formatTokens(t.total)} tokens (${formatTokens(t.input)} in, ${formatTokens(t.output)} out, ${formatTokens(t.cacheRead + t.cacheWrite)} cache)`,
    );
    const cost = formatCost(stats.cost);
    if (cost) parts.push(cost);
  }
  return parts.length ? parts.join(" · ") : "No usage yet";
}
