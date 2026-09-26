/**
 * Polls subscription usage limits (via the harness's optional `getUsageLimits`) and pushes them
 * to clients as `usage_limits` messages.
 *
 * - Polls every `intervalMs` only while at least one client is connected (`setClientCount`), and
 *   shortly after each run ends (`onRunEnd`).
 * - Fetches are coalesced and rate-limited (`minIntervalMs` between fetches unless forced).
 * - On failure (`null` or throw) it keeps the last good value, marked `stale`, and pushes that once.
 * - Pushes only when the value changed (ignoring `fetchedAt`), or when the last pushed value is
 *   older than `heartbeatMs` so the UI's "Updated … ago" stays roughly right.
 */
import type { ServerMessage, UsageLimits } from "@pi-ui/protocol";

export interface UsageLimitsPollerOptions {
  fetchLimits: () => Promise<UsageLimits | null>;
  broadcast: (message: ServerMessage) => void;
  intervalMs?: number;
  minIntervalMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export class UsageLimitsPoller {
  private readonly fetchLimits: () => Promise<UsageLimits | null>;
  private readonly broadcast: (message: ServerMessage) => void;
  private readonly intervalMs: number;
  private readonly minIntervalMs: number;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly log?: (msg: string) => void;

  private value: UsageLimits | null = null;
  private lastPushedAt = 0;
  private lastFetchAt = -Infinity;
  private inflight: Promise<void> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private deferred: ReturnType<typeof setTimeout> | null = null;
  private clients = 0;
  private running = false;

  constructor(options: UsageLimitsPollerOptions) {
    this.fetchLimits = options.fetchLimits;
    this.broadcast = options.broadcast;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.minIntervalMs = options.minIntervalMs ?? 15_000;
    this.heartbeatMs = options.heartbeatMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  /** Latest value (possibly stale), for newly connected clients. */
  current(): UsageLimits | null {
    return this.value;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.sync();
  }

  stop(): void {
    this.running = false;
    this.sync();
  }

  /** Number of connected clients; polling only happens while it's > 0. */
  setClientCount(count: number): void {
    const had = this.clients > 0;
    this.clients = Math.max(0, count);
    if (had !== this.clients > 0) this.sync();
  }

  /** A run finished: usage changed, refresh soon (respecting the rate limit). */
  onRunEnd(): void {
    if (!this.active()) return;
    const wait = this.lastFetchAt + this.minIntervalMs - this.now();
    if (wait <= 0) {
      void this.refresh();
    } else if (!this.deferred) {
      this.deferred = unref(
        setTimeout(() => {
          this.deferred = null;
          if (this.active()) void this.refresh();
        }, wait),
      );
    }
  }

  /** Fetch now (coalesced; skipped if the last fetch was < `minIntervalMs` ago unless forced). */
  refresh(force = false): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!force && this.now() - this.lastFetchAt < this.minIntervalMs) return Promise.resolve();
    this.lastFetchAt = this.now();
    this.inflight = this.doFetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doFetch(): Promise<void> {
    let next: UsageLimits | null;
    try {
      next = await this.fetchLimits();
    } catch (err) {
      this.log?.(`usage limits fetch failed: ${(err as Error).message}`);
      next = null;
    }
    if (next) {
      this.update({ ...next, stale: false });
    } else if (this.value && !this.value.stale) {
      this.update({ ...this.value, stale: true });
    }
  }

  private update(next: UsageLimits): void {
    const prev = this.value;
    this.value = next;
    const changed = !prev || !sameValue(prev, next);
    if (changed || this.now() - this.lastPushedAt >= this.heartbeatMs) {
      this.lastPushedAt = this.now();
      this.broadcast({ type: "usage_limits", usage: next });
    }
  }

  private active(): boolean {
    return this.running && this.clients > 0;
  }

  /** Start/stop the interval to match `running && clients > 0`. */
  private sync(): void {
    if (this.active()) {
      if (this.interval) return;
      this.interval = unref(setInterval(() => void this.refresh(), this.intervalMs));
      void this.refresh();
    } else {
      if (this.interval) clearInterval(this.interval);
      if (this.deferred) clearTimeout(this.deferred);
      this.interval = null;
      this.deferred = null;
    }
  }
}

function sameValue(a: UsageLimits, b: UsageLimits): boolean {
  return a.source === b.source && a.stale === b.stale && JSON.stringify(a.limits) === JSON.stringify(b.limits);
}

function unref<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}
