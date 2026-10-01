/**
 * Usage limits for every agent (I-191): one {@link UsageLimitsPoller} per harness that has
 * `getUsageLimits`, combined into one `usage_limits` message with an entry per offered agent that
 * has limits, the default agent first.
 *
 *   const hub = new UsageLimitsHub({ harnesses: () => registry.list(), isOffered, defaultId, broadcast });
 *   hub.start(); hub.setClientCount(1); hub.onRunEnd(); hub.entries();
 *
 * Harnesses whose limits are costly to read (e.g. Claude Code starts a process) slow their own
 * polling with `usageLimitsPolling`. A harness that isn't offered (turned off, uninstalled) isn't
 * polled and its entry is left out.
 */
import type { HarnessUsageLimits, ServerMessage, UsageLimits } from "@glade/protocol";
import type { AgentHarness } from "../harness/types.js";
import { UsageLimitsPoller } from "./usage-limits.js";

export interface UsageLimitsHubOptions {
  /** Every registered harness (re-read, so harnesses added later get a poller). */
  harnesses: () => AgentHarness[];
  /** Offered for new chats (installed and turned on). Default: all are. */
  isOffered?: (harness: AgentHarness) => boolean;
  /** The default harness's id (its entry goes first). */
  defaultId: () => string;
  broadcast: (message: ServerMessage) => void;
  /** Poll timing for every poller (tests); a harness's `usageLimitsPolling` wins. */
  timing?: { intervalMs?: number; minIntervalMs?: number; heartbeatMs?: number };
  now?: () => number;
  log?: (msg: string) => void;
}

/** The `usage_limits` message for these entries (`usage`: the default agent's, for older clients). */
export function usageLimitsMessage(entries: HarnessUsageLimits[], defaultId: string): ServerMessage {
  return { type: "usage_limits", usage: entries.find((e) => e.harnessId === defaultId)?.usage ?? null, entries };
}

export class UsageLimitsHub {
  private readonly pollers = new Map<string, { harness: AgentHarness; poller: UsageLimitsPoller }>();
  private running = false;
  private clients = 0;

  constructor(private readonly options: UsageLimitsHubOptions) {
    this.ensurePollers();
  }

  /** Any harness reports limits (otherwise the feature stays off). */
  get enabled(): boolean {
    return this.options.harnesses().some((h) => h.getUsageLimits);
  }

  /** Current entries (possibly stale): offered harnesses with limits, the default first. */
  entries(): HarnessUsageLimits[] {
    const defaultId = this.options.defaultId();
    const list: HarnessUsageLimits[] = [];
    for (const { harness, poller } of this.pollers.values()) {
      const usage = poller.current();
      if (!usage || usage.limits.length === 0 || !this.offered(harness)) continue;
      list.push({ harnessId: harness.id, label: harness.info.label, usage });
    }
    const at = list.findIndex((e) => e.harnessId === defaultId);
    return at > 0 ? [list[at]!, ...list.slice(0, at), ...list.slice(at + 1)] : list;
  }

  /** The message for a newly connected client, or `null` when there's nothing to show. */
  message(): ServerMessage | null {
    const entries = this.entries();
    return entries.length ? usageLimitsMessage(entries, this.options.defaultId()) : null;
  }

  start(): void {
    this.running = true;
    for (const p of this.each()) p.start();
  }

  stop(): void {
    this.running = false;
    for (const { poller } of this.pollers.values()) poller.stop();
  }

  setClientCount(count: number): void {
    this.clients = count;
    for (const p of this.each()) p.setClientCount(count);
  }

  onRunEnd(): void {
    for (const p of this.each()) p.onRunEnd();
  }

  /** Refresh every agent now (tests; coalesced per harness). */
  async refresh(force = false): Promise<void> {
    await Promise.all(this.each().map((p) => p.refresh(force)));
  }

  private offered(harness: AgentHarness): boolean {
    return this.options.isOffered ? this.options.isOffered(harness) : true;
  }

  private each(): UsageLimitsPoller[] {
    this.ensurePollers();
    return [...this.pollers.values()].map((p) => p.poller);
  }

  /** A poller for every harness with `getUsageLimits` (new ones join in the hub's state). */
  private ensurePollers(): void {
    for (const harness of this.options.harnesses()) {
      if (!harness.getUsageLimits || this.pollers.has(harness.id)) continue;
      const poller = new UsageLimitsPoller({
        fetchLimits: async (): Promise<UsageLimits | null> => (this.offered(harness) ? ((await harness.getUsageLimits?.()) ?? null) : null),
        push: () => this.broadcast(),
        ...this.options.timing,
        ...harness.usageLimitsPolling,
        ...(this.options.now ? { now: this.options.now } : {}),
        log: this.options.log ? (msg) => this.options.log?.(`${harness.id}: ${msg}`) : undefined,
      });
      this.pollers.set(harness.id, { harness, poller });
      if (this.clients) poller.setClientCount(this.clients);
      if (this.running) poller.start();
    }
  }

  private broadcast(): void {
    this.options.broadcast(usageLimitsMessage(this.entries(), this.options.defaultId()));
  }
}
