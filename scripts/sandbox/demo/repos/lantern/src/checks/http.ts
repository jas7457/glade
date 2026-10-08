import type { CheckConfig } from "../config.js";

export interface CheckResult {
  checkId: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error?: string;
  at: number;
}

export async function runHttpCheck(check: CheckConfig): Promise<CheckResult> {
  const started = performance.now();
  const at = Date.now();
  try {
    const res = await fetch(check.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(check.timeoutMs),
    });
    const [min, max] = check.expectStatus ?? [200, 399];
    const ok = res.status >= min && res.status <= max;
    return { checkId: check.id, ok, status: res.status, latencyMs: Math.round(performance.now() - started), at };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { checkId: check.id, ok: false, status: null, latencyMs: Math.round(performance.now() - started), error, at };
  }
}
