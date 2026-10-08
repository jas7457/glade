import { readFileSync } from "node:fs";

export interface CheckConfig {
  id: string;
  name: string;
  url: string;
  /** Seconds between two runs. */
  intervalSec: number;
  /** A response slower than this counts as down. */
  timeoutMs: number;
  /** Status codes that count as up (default 200–399). */
  expectStatus?: [number, number];
}

export type NotifierConfig =
  | { type: "slack"; webhookUrl: string }
  | { type: "webhook"; url: string; headers?: Record<string, string> };

export interface LanternConfig {
  port: number;
  dbPath: string;
  checks: CheckConfig[];
  notify: NotifierConfig[];
}

const DEFAULT_CHECK = { intervalSec: 60, timeoutMs: 10_000 };

export function loadConfig(path: string): LanternConfig {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw.checks) || raw.checks.length === 0) {
    throw new Error(`${path}: "checks" must list at least one check`);
  }
  return {
    port: raw.port ?? 7070,
    dbPath: raw.dbPath ?? "lantern.db",
    checks: raw.checks.map((c: Partial<CheckConfig>) => ({ ...DEFAULT_CHECK, ...c }) as CheckConfig),
    notify: raw.notify ?? [],
  };
}
