/**
 * Claude Code's plan usage limits (I-191): the SDK's experimental `/usage` data
 * (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, `get_usage` on the control
 * channel), read from a short-lived Claude Code process: no model call. Its `rate_limits` is the
 * claude.ai usage endpoint's body, so pi's parser maps it (`parseAnthropicUsage`).
 *
 * Parsed defensively: an unexpected shape, an API-key login (`rate_limits_available: false`) or a
 * newer SDK without the method → `null` (Claude Code left out of the gauge).
 */
import type { UsageLimits } from "@glade/protocol";
import { parseAnthropicUsage } from "../../services/providers/anthropic-usage.js";
import { CLAUDE_PROVIDER } from "./models.js";

/** The `get_usage` answer → Glade's limits, or `null` when there are none. */
export function claudeUsageLimits(response: unknown, fetchedAt = Date.now()): UsageLimits | null {
  if (!isRecord(response) || response.rate_limits_available !== true) return null;
  const parsed = parseAnthropicUsage(response.rate_limits, fetchedAt);
  if (!parsed) return null;
  const plan = typeof response.subscription_type === "string" && response.subscription_type ? ` (${response.subscription_type})` : "";
  return { ...parsed, source: `Claude subscription${plan}`, provider: CLAUDE_PROVIDER };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
