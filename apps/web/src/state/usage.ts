/**
 * Subscription usage limits (I-015): the `usageLimits` signal fed by the server's
 * `usage_limits` push, a toast when a limit escalates, and pure formatting helpers shared by the
 * sidebar gauge and its popover. `null` means unavailable → the UI hides the feature.
 */
import { signal } from "@preact/signals";
import type { UsageLimit, UsageLimits } from "@pi-ui/protocol";
import { showToast } from "./toasts";

export const usageLimits = signal<UsageLimits | null>(null);

const SEVERITY_RANK: Record<UsageLimit["severity"], number> = { normal: 0, warning: 1, critical: 2 };

/** Apply a `usage_limits` message; toasts when a limit escalates (see {@link limitAlerts}). */
export function handleUsageMessage(next: UsageLimits | null, notify: typeof showToast = showToast, now = Date.now()): void {
  const prev = usageLimits.value;
  usageLimits.value = next;
  if (!next || next.stale) return;
  for (const limit of limitAlerts(prev, next)) {
    const critical = limit.severity === "critical";
    const reset = formatResetsAt(limit.resetsAt, now);
    notify({
      level: critical ? "error" : "warning",
      title: critical ? `${limit.label}: limit almost reached` : `${limit.label}: ${formatPercent(limit.percent)} used`,
      message: `${formatPercent(limit.percent)} of your ${next.source} limit used.${reset ? ` ${reset}.` : ""}`,
      timeoutMs: critical ? 10_000 : 6_000,
    });
  }
}

/**
 * Limits worth a toast: compared with the previous value, severity went up (to warning or
 * critical), or the limit became the active one while not normal. Nothing on the first value
 * (the gauge's colour already shows it; avoids a toast on every reload).
 */
export function limitAlerts(prev: UsageLimits | null, next: UsageLimits): UsageLimit[] {
  if (!prev) return [];
  const before = new Map(prev.limits.map((l) => [l.id, l]));
  return next.limits.filter((limit) => {
    const old = before.get(limit.id);
    if (!old || limit.severity === "normal") return false;
    return SEVERITY_RANK[limit.severity] > SEVERITY_RANK[old.severity] || (limit.active && !old.active);
  });
}

/** The limit to show in the compact gauge: worst severity, then the active one, then the fullest. */
export function primaryLimit(limits: readonly UsageLimit[]): UsageLimit | null {
  let best: UsageLimit | null = null;
  const score = (l: UsageLimit) => [SEVERITY_RANK[l.severity], l.active ? 1 : 0, l.percent];
  for (const limit of limits) {
    if (!best) {
      best = limit;
      continue;
    }
    const a = score(limit);
    const b = score(best);
    const i = a.findIndex((v, k) => v !== b[k]);
    if (i !== -1 && a[i]! > b[i]!) best = limit;
  }
  return best;
}

export function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}

const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * "Resets at 6:40 PM" (today), "Resets Saturday 12:00 PM" (within a week), "Resets Oct 12,
 * 9:00 AM" (later), in local time. `null` if unknown.
 */
export function formatResetsAt(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  const t = Math.round(parsed / 60_000) * 60_000; // the API says 18:39:59.87 for 18:40
  const date = new Date(t);
  const days = Math.round((startOfDay(t) - startOfDay(now)) / 86_400_000);
  if (days <= 0) return `Resets at ${time(date)}`;
  if (days < 7) return `Resets ${date.toLocaleDateString(undefined, { weekday: "long" })} ${time(date)}`;
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  const day = date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
  return `Resets ${day}, ${time(date)}`;
}

/** "Updated just now", "Updated 2 min ago", "Updated 3 hr ago". */
export function formatUpdatedAgo(fetchedAt: number, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - fetchedAt) / 60_000);
  if (min < 1) return "Updated just now";
  if (min < 60) return `Updated ${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Updated ${hr} hr ago`;
  return `Updated ${new Date(fetchedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}
