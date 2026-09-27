/**
 * pi's Anthropic OAuth token (`~/.pi/agent/auth.json`, written by the `pi-anthropic-oauth`
 * extension), for the subscription usage limits (`services/providers/anthropic-usage.ts`).
 * Read-only: never refresh or log the token.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AnthropicOAuthToken } from "../../services/providers/anthropic-usage.js";

export function defaultPiAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

/** pi's Anthropic OAuth credentials, or `null` if missing / not OAuth / unreadable. */
export function readPiAnthropicAuth(authPath = defaultPiAuthPath()): AnthropicOAuthToken | null {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(authPath, "utf8"));
  } catch {
    return null;
  }
  const entry = isRecord(data) ? data.anthropic : undefined;
  if (!isRecord(entry) || entry.type !== "oauth") return null;
  if (typeof entry.access !== "string" || entry.access === "") return null;
  const expires = typeof entry.expires === "number" && Number.isFinite(entry.expires) ? entry.expires : 0;
  return { access: entry.access, expires, type: "oauth" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
