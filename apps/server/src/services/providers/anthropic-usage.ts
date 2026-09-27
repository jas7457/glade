/**
 * Claude subscription usage limits (session / weekly / per-model) for an Anthropic OAuth login.
 * Harness-independent (I-069): the harness supplies the OAuth token (pi:
 * `harness/pi/anthropic-auth.ts`, from `~/.pi/agent/auth.json`).
 *
 * Calls the undocumented `GET /api/oauth/usage` endpoint that Claude Code's `/usage` uses. Rules:
 * - Only READ the token; never refresh it (refreshing rotates it and could log the harness out).
 *   If it's expired we return `null` and the caller keeps showing the last values as stale.
 * - Never log the token.
 * - Parse defensively and never throw: any failure or unexpected shape → `null` (feature hidden).
 *
 *   getUsageLimits = () => fetchAnthropicUsageLimits({ token: () => readPiAnthropicAuth() });
 */
import type { UsageLimit, UsageLimits } from "@glade/protocol";

export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Provider id of Anthropic models (`ModelRef.provider`); the limits apply to these. */
export const ANTHROPIC_PROVIDER = "anthropic";
const TIMEOUT_MS = 10_000;

/** An Anthropic OAuth access token as stored by a harness. */
export interface AnthropicOAuthToken {
  access: string;
  /** Expiry, ms epoch (0 if unknown). */
  expires: number;
  type: "oauth";
}

export interface FetchAnthropicUsageOptions {
  /** The current OAuth token, or `null` when not logged in with OAuth. */
  token: () => AnthropicOAuthToken | null;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

/** Current subscription limits, or `null` if unavailable (no OAuth login, expired token, error). */
export async function fetchAnthropicUsageLimits(options: FetchAnthropicUsageOptions): Promise<UsageLimits | null> {
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? globalThis.fetch;
  let auth: AnthropicOAuthToken | null;
  try {
    auth = options.token();
  } catch {
    return null;
  }
  if (!auth) return null;
  if (auth.expires > 0 && auth.expires <= now()) return null; // the harness refreshes it on its next request

  try {
    const res = await doFetch(ANTHROPIC_USAGE_URL, {
      headers: { Authorization: `Bearer ${auth.access}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseAnthropicUsage(await res.json(), now());
  } catch {
    return null;
  }
}

/** Map the endpoint's JSON to {@link UsageLimits}; `null` if it doesn't look as expected. */
export function parseAnthropicUsage(body: unknown, fetchedAt: number): UsageLimits | null {
  if (!isRecord(body) || !Array.isArray(body.limits)) return null;
  const limits: UsageLimit[] = [];
  const seen = new Set<string>();
  for (const raw of body.limits) {
    const limit = parseLimit(raw);
    if (!limit || seen.has(limit.id)) continue;
    seen.add(limit.id);
    limits.push(limit);
  }
  const extra = parseExtraUsage(body.extra_usage);
  if (extra) limits.push(extra);
  if (limits.length === 0) return null;
  return { source: "Claude subscription", provider: ANTHROPIC_PROVIDER, limits, fetchedAt, stale: false };
}

function parseLimit(raw: unknown): UsageLimit | null {
  if (!isRecord(raw) || typeof raw.kind !== "string" || raw.kind === "") return null;
  const percent = toPercent(raw.percent);
  if (percent === null) return null;
  const { id, label, model } = identify(raw.kind, raw.scope);
  return {
    id,
    label,
    percent,
    resetsAt: toIso(raw.resets_at),
    severity: toSeverity(raw.severity),
    active: raw.is_active === true,
    ...(model ? { model } : {}),
  };
}

function identify(kind: string, scope: unknown): { id: string; label: string; model?: string } {
  switch (kind) {
    case "session":
      return { id: "session", label: "Current session" };
    case "weekly_all":
      return { id: "weekly_all", label: "This week" };
    case "weekly_scoped": {
      const model = isRecord(scope) && isRecord(scope.model) ? scope.model : null;
      const name = model && typeof model.display_name === "string" ? model.display_name.trim() : "";
      if (name) return { id: `weekly_scoped:${name}`, label: `${name} this week`, model: name };
      const surface = isRecord(scope) && typeof scope.surface === "string" ? scope.surface.trim() : "";
      if (surface) return { id: `weekly_scoped:${surface}`, label: `${humanize(surface)} this week` };
      return { id: "weekly_scoped", label: "Scoped limit this week" };
    }
    default:
      return { id: kind, label: humanize(kind) };
  }
}

function parseExtraUsage(raw: unknown): UsageLimit | null {
  if (!isRecord(raw) || raw.is_enabled !== true) return null;
  const percent = toPercent(raw.utilization);
  if (percent === null) return null;
  return {
    id: "extra_usage",
    label: "Extra usage",
    percent,
    resetsAt: null,
    severity: raw.spend_limit_reached === true ? "critical" : "normal",
    active: false,
  };
}

function toPercent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, value));
}

function toIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function toSeverity(value: unknown): UsageLimit["severity"] {
  return value === "warning" || value === "critical" ? value : "normal";
}

/** "weekly_opus" → "Weekly opus". */
function humanize(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
