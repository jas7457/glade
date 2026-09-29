/**
 * Codex's errors and usage limits in Glade's words (I-177). Pure.
 *
 * - A turn that fails on the account's usage limit (`codexErrorInfo: "usageLimitExceeded"`, or a
 *   reached `rateLimitReachedType`) says so plainly with the real reset date from
 *   `account/rateLimits/read`: "Codex usage limit reached — resets Oct 13". Codex's own text
 *   (upgrade hint, exact time) is kept as the details.
 * - Sign-in and install problems read like Claude Code's ("Codex isn't logged in. Run `codex login`
 *   …").
 * - {@link codexUsageLimits}: the rate-limit windows as Glade's usage gauge.
 */
import type { UsageLimit, UsageLimits } from "@glade/protocol";
import { CODEX_PROVIDER } from "./models.js";
import type { GetAccountRateLimitsResponse, RateLimitSnapshot, RateLimitWindow, TurnError } from "./protocol.js";

export const NOT_INSTALLED = "Codex isn't installed: `codex` wasn't found on this device's PATH.";
export const NOT_LOGGED_IN = "Codex isn't logged in. Run `codex login` in a terminal, then try again.";

/** The code of a `codexErrorInfo` (`"usageLimitExceeded"`, `{ httpConnectionFailed: … }` → its key). */
export function errorCode(info: TurnError["codexErrorInfo"] | undefined): string | null {
  if (!info) return null;
  if (typeof info === "string") return info;
  return Object.keys(info)[0] ?? null;
}

/** "Oct 13" (plus the year when it isn't this year; the time when it's within a day). */
export function formatReset(at: Date, now: Date = new Date()): string {
  const withinDay = at.getTime() - now.getTime() < 24 * 3600_000 && at.getTime() > now.getTime();
  if (withinDay) return `at ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", ...(at.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) };
  return at.toLocaleDateString("en-US", opts);
}

function windows(snapshot: RateLimitSnapshot | null | undefined): RateLimitWindow[] {
  return [snapshot?.primary, snapshot?.secondary].filter((w): w is RateLimitWindow => !!w);
}

/** When the limit that's used up resets (the latest of the full windows), or `null`. */
export function limitResetsAt(snapshot: RateLimitSnapshot | null | undefined): Date | null {
  const full = windows(snapshot).filter((w) => w.usedPercent >= 100 && w.resetsAt);
  const pick = full.length ? full : windows(snapshot).filter((w) => w.resetsAt);
  const at = pick.reduce<number | null>((max, w) => (max === null || w.resetsAt! > max ? w.resetsAt! : max), null);
  return at ? new Date(at * 1000) : null;
}

/** Whether the account's usage is used up (and no credits left to go on with). */
export function isLimitReached(limits: GetAccountRateLimitsResponse | null | undefined): boolean {
  if (!limits) return false;
  const snap = limits.rateLimits;
  if (snap.credits?.hasCredits || snap.credits?.unlimited) return false;
  return limits.ordinaryUsageAllowed === false || !!snap.rateLimitReachedType || windows(snap).some((w) => w.usedPercent >= 100);
}

/** "Codex usage limit reached — resets Oct 13". */
export function usageLimitMessage(snapshot: RateLimitSnapshot | null | undefined, now: Date = new Date()): string {
  const at = limitResetsAt(snapshot);
  return at ? `Codex usage limit reached — resets ${formatReset(at, now)}` : "Codex usage limit reached";
}

export interface FriendlyTurnError {
  message: string;
  details?: string;
}

/** A failed turn's error for the chat. `limits`: the latest `account/rateLimits/read`, when known. */
export function friendlyTurnError(error: TurnError | null | undefined, limits: GetAccountRateLimitsResponse | null | undefined, now: Date = new Date()): FriendlyTurnError {
  const text = error?.message?.trim() || "Codex stopped with an error";
  const extra = error?.additionalDetails?.trim();
  const details = [text, extra].filter(Boolean).join("\n");
  switch (errorCode(error?.codexErrorInfo)) {
    case "usageLimitExceeded":
      return { message: usageLimitMessage(limits?.rateLimits, now), details };
    case "rateLimitExceeded":
      return isLimitReached(limits) ? { message: usageLimitMessage(limits?.rateLimits, now), details } : { message: "Codex is being rate limited. Try again in a moment.", details };
    case "unauthorized":
      return { message: NOT_LOGGED_IN, details };
    case "contextWindowExceeded":
      return { message: "The conversation no longer fits the model's context window. Compact it (/compact) or start a new chat.", details };
    case "serverOverloaded":
      return { message: "Codex's servers are overloaded right now. Try again in a moment.", details };
    default:
      if (/usage limit/i.test(text)) return { message: usageLimitMessage(limits?.rateLimits, now), details };
      if (/not logged in|log ?in required|please (log|sign) in|401 unauthorized/i.test(text)) return { message: NOT_LOGGED_IN, details };
      return extra ? { message: text, details: extra } : { message: text };
  }
}

/** A window's label by its length. */
function windowLabel(mins: number | null): string {
  if (!mins) return "Usage";
  if (mins <= 24 * 60) return mins % 60 === 0 ? `${mins / 60}-hour limit` : "Current session";
  if (mins <= 7 * 24 * 60) return "This week";
  return "This month";
}

/** Codex's rate limits → Glade's usage gauge. */
export function codexUsageLimits(response: GetAccountRateLimitsResponse, fetchedAt = Date.now()): UsageLimits {
  const snap = response.rateLimits;
  const list = [
    ["primary", snap.primary],
    ["secondary", snap.secondary],
  ] as const;
  const limits: UsageLimit[] = [];
  for (const [id, w] of list) {
    if (!w) continue;
    const percent = Math.max(0, Math.min(100, w.usedPercent));
    limits.push({
      id,
      label: windowLabel(w.windowDurationMins),
      percent,
      resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null,
      severity: percent >= 90 ? "critical" : percent >= 75 ? "warning" : "normal",
      active: false,
    });
  }
  const top = limits.reduce<UsageLimit | null>((a, l) => (!a || l.percent > a.percent ? l : a), null);
  if (top) top.active = true;
  const plan = snap.planType && snap.planType !== "unknown" ? ` (${snap.planType})` : "";
  return { source: `Codex${plan}`, provider: CODEX_PROVIDER, limits, fetchedAt, stale: false };
}
