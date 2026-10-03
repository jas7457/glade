/**
 * Subscription usage limits (I-015, I-057, I-191): `usageLimits`, per environment (each Mac's own
 * accounts) one entry per agent that reports limits, the default agent first, fed by the
 * server's `usage_limits` push; a toast when a limit escalates; the order a chat shows them in
 * ({@link usageForChat}: its own agent first); pure formatting helpers for the chat's usage
 * popover. Nothing for an environment → the UI hides the feature.
 *
 *   usageLimitsOf(envIdOfSession(chatId)) // the limits of the Mac the chat runs on
 */
import { signal } from "@preact/signals";
import type { HarnessUsageLimits, ModelRef, ServerMessage, UsageLimit, UsageLimits } from "@glade/protocol";
import { hasLocalEnvironment, isLocalEnvironment } from "./env-registry";
import { showToast } from "./toasts";

/** Limits per environment ({@link usageKey}). */
export const usageLimits = signal<ReadonlyMap<string, HarnessUsageLimits[]>>(new Map());

/** Map key of an environment's limits: "" for this device's own server (also untagged), else its id. */
export function usageKey(envId: string | null | undefined): string {
  return !envId || isLocalEnvironment(envId) ? "" : envId;
}

/** The limits of the environment a chat runs on (empty: none). */
export function usageLimitsOf(envId: string | null | undefined): HarnessUsageLimits[] {
  return usageLimits.value.get(usageKey(envId)) ?? [];
}

const SEVERITY_RANK: Record<UsageLimit["severity"], number> = { normal: 0, warning: 1, critical: 2 };

type UsageMessage = Pick<Extract<ServerMessage, { type: "usage_limits" }>, "usage" | "entries">;

/** The message's entries; an older server sends only `usage` (its default agent's, unnamed). */
export function usageEntries(message: UsageMessage): HarnessUsageLimits[] {
  if (message.entries) return message.entries.filter((e) => e.usage.limits.length > 0);
  return message.usage && message.usage.limits.length ? [{ harnessId: "", label: message.usage.source, usage: message.usage }] : [];
}

/**
 * Apply an environment's `usage_limits` message; toasts when a limit escalates (see
 * {@link limitAlerts}): for this device's own server, or any Mac on a device without one (the
 * iPhone), not for another Mac's accounts on a desktop.
 */
export function handleUsageMessage(message: UsageMessage, envId?: string, notify: typeof showToast = showToast, now = Date.now()): void {
  const key = usageKey(envId);
  const prev = new Map((usageLimits.value.get(key) ?? []).map((e) => [e.harnessId, e.usage]));
  const next = usageEntries(message);
  const all = new Map(usageLimits.value);
  if (next.length) all.set(key, next);
  else all.delete(key);
  usageLimits.value = all;
  if (key !== "" && hasLocalEnvironment.value) return;
  for (const { harnessId, usage } of next) {
    if (usage.stale) continue;
    for (const limit of limitAlerts(prev.get(harnessId) ?? null, usage)) {
      const critical = limit.severity === "critical";
      const reset = formatResetsAt(limit.resetsAt, now);
      notify({
        level: critical ? "error" : "warning",
        title: critical ? `${limit.label}: limit almost reached` : `${limit.label}: ${formatPercent(limit.percent)} used`,
        message: `${formatPercent(limit.percent)} of your ${usage.source} limit used.${reset ? ` ${reset}.` : ""}`,
        timeoutMs: critical ? 10_000 : 6_000,
      });
    }
  }
}

/**
 * The limits a chat's usage popover shows (I-191, I-195): only its own agent's, and only when they
 * apply to the chat's model (same provider; e.g. pi's Claude subscription only for an Anthropic
 * model). Other agents' limits are left out; without a known agent there are none.
 */
export function usageForChat(entries: readonly HarnessUsageLimits[], harnessId: string | null | undefined, model?: ModelRef | null): HarnessUsageLimits[] {
  return entries.filter((e) => e.usage.limits.length > 0 && isMine(e, harnessId, model));
}

function isMine(entry: HarnessUsageLimits, harnessId: string | null | undefined, model: ModelRef | null | undefined): boolean {
  if (!harnessId) return false;
  // An older server's unnamed entry is the default agent's: match it by the model's provider.
  if (entry.harnessId && entry.harnessId !== harnessId) return false;
  return !model || model.provider === entry.usage.provider;
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

/**
 * Whether a per-model limit (`limit.model`, e.g. "Fable") is about `model`: its id contains the
 * scope's name, compared case-insensitively with spaces as dashes ("Fable" ~ "claude-fable-5").
 * `false` for limits that aren't model-scoped.
 */
export function limitMatchesModel(limit: UsageLimit, model: ModelRef | null | undefined): boolean {
  if (!limit.model || !model) return false;
  const key = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const scope = key(limit.model);
  return scope !== "" && key(model.id).includes(scope);
}

/** The most constraining limit: worst severity, then the active one, then the fullest. */
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
 * "Resets at 6:40 PM" (today), "Resets Saturday 12:00 PM" (up to 7 calendar days away), "Resets Oct 12,
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
  // Up to 7 calendar days: a weekly limit resets on the same weekday next week (Claude says so too).
  if (days <= 7) return `Resets ${date.toLocaleDateString(undefined, { weekday: "long" })} ${time(date)}`;
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
