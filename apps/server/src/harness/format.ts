/**
 * Small display formatters shared by harness adapters (text they put into notices/toasts).
 */

/** 950 → "950", 42_130 → "42.1k", 150_000 → "150k", 1_200_000 → "1.2M". */
export function formatTokenCount(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}

function trim(value: number): string {
  // One decimal below 100 (42.1k), none above (150k).
  return Math.abs(value) >= 100 ? String(Math.round(value)) : String(Number(value.toFixed(1)));
}

/** "Compacted context: 150k → 32k tokens" (parts omitted when unknown). */
export function compactionNoticeText(before: number | null, after: number | null): string {
  if (before !== null && after !== null) return `Compacted context: ${formatTokenCount(before)} → ${formatTokenCount(after)} tokens`;
  if (before !== null) return `Compacted context (was ${formatTokenCount(before)} tokens)`;
  return "Context compacted";
}
