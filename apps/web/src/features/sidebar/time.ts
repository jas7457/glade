/** Compact relative time for sidebar rows: "now", "5m", "3h", "2d", "3w", then "Mar 4". */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - timestamp) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 28) return `${Math.floor(d / 7)}w`;
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" });
}
