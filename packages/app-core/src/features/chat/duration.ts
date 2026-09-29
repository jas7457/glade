/**
 * Elapsed-time helpers for the chat (I-070): a compact formatter ("4s", "1m 12s", "1h 3m"),
 * durations of tool calls and groups from the server's timing stamps, and a clock hook that
 * ticks once per second while something is live.
 *
 * Old history has no stamps; every helper returns `null` then and the UI shows nothing rather
 * than guessing.
 */
import { useEffect, useState } from "preact/hooks";
import type { ToolResult } from "@glade/protocol";

/** "0s", "4s", "1m 12s", "1h 3m" (floored; negative counts as 0). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** How long a tool ran (live: until `now` while it has no end stamp). `null` when unknown. */
export function toolDuration(result: ToolResult | undefined, now: number): number | null {
  if (!result || result.startedAt === undefined) return null;
  if (result.endedAt !== undefined) return result.endedAt - result.startedAt;
  return result.status === "running" ? now - result.startedAt : null;
}

/**
 * Wall-clock span of a group of tool calls: first start → last end, or → `now` while the group
 * is `active` (a call still streams, waits or runs). Tools can overlap and the model works
 * between them, so this is what the user waited, not the sum of the rows. `null` unless every
 * call that has a result is stamped.
 */
export function groupDuration(results: ReadonlyArray<ToolResult | undefined>, now: number, active = false): number | null {
  let start = Infinity;
  let end = -Infinity;
  for (const r of results) {
    if (!r) continue;
    if (r.startedAt === undefined) return null;
    start = Math.min(start, r.startedAt);
    const stop = r.endedAt ?? (r.status === "running" ? now : undefined);
    if (stop === undefined) return null;
    end = Math.max(end, stop);
  }
  if (start === Infinity) return null;
  return Math.max(0, (active ? now : end) - start);
}

/** `Date.now()`, re-rendering once per second while `live` (aligned to whole seconds of `from`). */
export function useNow(live: boolean, from?: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      // Next whole second since `from`, so "1s → 2s" flips on time rather than drifting.
      const phase = from ? (t - from) % 1000 : t % 1000;
      timer = setTimeout(tick, 1000 - phase + 5);
    };
    const t0 = Date.now();
    timer = setTimeout(tick, 1000 - (from ? (t0 - from) % 1000 : t0 % 1000) + 5);
    return () => clearTimeout(timer);
  }, [live, from]);
  // The state only schedules re-renders; read the clock itself so a fresh render is never stale.
  return live ? Date.now() : now;
}
