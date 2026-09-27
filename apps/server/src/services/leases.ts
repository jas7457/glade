/**
 * Session leases (I-062): only one Glade server may run a given session's agent process, even
 * when several servers share the data folder (two `pi` processes on one session file would
 * interleave writes). `<dataDir>/leases/<sessionId>.json` names the server that runs it:
 *
 *   { sessionId, serverId, serverKind, pid, since, running, pendingInputs, updatedAt, takeover? }
 *
 * - A server **claims** the lease before starting the session's process and releases it when the
 *   process stops. `running` / `pendingInputs` are kept current so the other servers can show
 *   the session's status (working / blocked) without streaming its events.
 * - A lease is **stale** when its server is gone (see server-registry.ts); stale leases are
 *   replaced on claim and removed by the periodic scan.
 * - **Take-over**: a server that needs a session whose owner is idle writes a `takeover` request
 *   into the lease; the owner notices (folder watch / scan), stops its idle process and releases
 *   the lease, and the requester claims it. A busy owner clears the request instead, and the
 *   requester reports the session as active elsewhere (HTTP 409).
 *
 * All reads-modify-writes run under the lease file's lock (store/file-lock.ts).
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { withFileLock } from "../store/file-lock.js";
import type { ServerRegistry } from "./server-registry.js";

export const LEASES_DIR = "leases";
/** How long a requester waits for an idle owner to hand a session over. */
export const TAKEOVER_WAIT_MS = 6_000;

export interface LeaseInfo {
  sessionId: string;
  serverId: string;
  serverKind: string;
  pid: number;
  /** When this server claimed it. */
  since: number;
  running: boolean;
  pendingInputs: number;
  updatedAt: number;
  /** Another server asked for the session (it's waiting for us to release it). */
  takeover?: { serverId: string; at: number };
}

export interface LeaseState {
  running: boolean;
  pendingInputs: number;
}

/** `requested`: this call recorded a take-over request in the (idle) owner's lease. */
export type ClaimResult = { ok: true } | { ok: false; lease: LeaseInfo; requested: boolean };

export interface LeaseManagerOptions {
  /** Leases of other servers appeared, changed state, or went away (session ids). */
  onForeignChange?: (sessionIds: string[]) => void;
  /** Another server wants one of our sessions; release it (if idle) or call `refuseTakeover`. */
  onTakeoverRequest?: (sessionId: string) => void;
  /** After every scan (the AppService looks for runs whose server went away). */
  onScan?: () => void;
  /** Periodic scan interval (default 1000ms; 0 = only on folder events / manual `scan()`). */
  scanMs?: number;
  now?: () => number;
}

export class LeaseManager {
  readonly dir: string;
  /** Last scan: sessionId -> foreign live lease. */
  private foreign = new Map<string, LeaseInfo>();
  /** Session ids we hold, with the state we last wrote. */
  private readonly held = new Map<string, LeaseState>();
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scanTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly handledTakeovers = new Set<string>();

  constructor(
    dataDir: string,
    readonly registry: ServerRegistry,
    private readonly options: LeaseManagerOptions = {},
  ) {
    this.dir = join(dataDir, LEASES_DIR);
    this.now = options.now ?? Date.now;
  }

  get serverId(): string {
    return this.registry.id;
  }

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    this.scan();
    try {
      this.watcher = watch(this.dir, () => this.scheduleScan());
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
      this.watcher.unref();
    } catch {
      /* the periodic scan still works */
    }
    const ms = this.options.scanMs ?? 1000;
    if (ms > 0) {
      this.timer = setInterval(() => this.scan(), ms);
      this.timer.unref();
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
  }

  private scheduleScan(): void {
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, 20);
    this.scanTimer.unref();
  }

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  private pathOf(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  read(sessionId: string): LeaseInfo | null {
    try {
      const value = JSON.parse(readFileSync(this.pathOf(sessionId), "utf8")) as LeaseInfo;
      return typeof value.serverId === "string" ? value : null;
    } catch {
      return null;
    }
  }

  /** The lease of another live server on this session (as of the last scan), if any. */
  foreignLease(sessionId: string): LeaseInfo | null {
    return this.foreign.get(sessionId) ?? null;
  }

  /** Read the file now: another live server holds this session. */
  foreignLeaseNow(sessionId: string): LeaseInfo | null {
    const lease = this.read(sessionId);
    return lease && lease.serverId !== this.serverId && this.registry.isLive(lease.serverId) ? lease : null;
  }

  /** Our lease is still on file (nobody took it over while we thought we had it). */
  holds(sessionId: string): boolean {
    return this.read(sessionId)?.serverId === this.serverId;
  }

  /** Sessions with a lease file of a live server (ours or others'). */
  isLeased(sessionId: string): boolean {
    const lease = this.read(sessionId);
    return !!lease && this.registry.isLive(lease.serverId);
  }

  // -------------------------------------------------------------------------------------------
  // Claiming and releasing
  // -------------------------------------------------------------------------------------------

  /**
   * Claim the session now if it's free, stale or already ours. If another live server holds it
   * and is idle, a take-over request is recorded; either way the blocking lease is returned.
   */
  claim(sessionId: string, state: LeaseState = { running: false, pendingInputs: 0 }): ClaimResult {
    const path = this.pathOf(sessionId);
    mkdirSync(this.dir, { recursive: true });
    const result = withFileLock(path, (): ClaimResult => {
      const current = this.read(sessionId);
      if (current && current.serverId !== this.serverId && this.registry.isLive(current.serverId)) {
        const request = !current.running && current.pendingInputs === 0 && !current.takeover;
        if (request) this.write({ ...current, takeover: { serverId: this.serverId, at: this.now() } });
        return { ok: false, lease: current, requested: request };
      }
      const now = this.now();
      const self = this.registry.self;
      const since = current?.serverId === this.serverId ? current.since : now;
      this.write({ sessionId, serverId: self.id, serverKind: self.kind, pid: self.pid, since, ...state, updatedAt: now });
      return { ok: true };
    });
    if (result.ok) {
      this.held.set(sessionId, state);
      this.dropForeign(sessionId);
    }
    return result;
  }

  /**
   * Claim, waiting up to `timeoutMs` for an idle owner to hand the session over. Resolves to
   * null once ours, or to the lease that blocks us (busy owner, or it didn't let go in time).
   */
  async acquire(sessionId: string, timeoutMs = TAKEOVER_WAIT_MS): Promise<LeaseInfo | null> {
    const deadline = this.now() + timeoutMs;
    let requested = false;
    for (;;) {
      const result = this.claim(sessionId);
      if (result.ok) return null;
      const { lease } = result;
      if (lease.running || lease.pendingInputs > 0) return lease; // busy there
      if (requested && !lease.takeover) return lease; // the owner refused (cleared our request)
      if (this.now() >= deadline) return lease;
      requested = requested || result.requested;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Update the state other servers see (only writes when it changed and the lease is ours). */
  setState(sessionId: string, state: LeaseState): void {
    const last = this.held.get(sessionId);
    if (!last || (last.running === state.running && last.pendingInputs === state.pendingInputs)) return;
    this.held.set(sessionId, state);
    const path = this.pathOf(sessionId);
    withFileLock(path, () => {
      const current = this.read(sessionId);
      if (current?.serverId !== this.serverId) return;
      // Becoming busy answers a pending take-over request with "no".
      const next: LeaseInfo = { ...current, ...state, updatedAt: this.now() };
      if (state.running || state.pendingInputs > 0) delete next.takeover;
      this.write(next);
    });
  }

  /** Answer a take-over request with "no" (we're busy): the requester stops waiting. */
  refuseTakeover(sessionId: string): void {
    withFileLock(this.pathOf(sessionId), () => {
      const current = this.read(sessionId);
      if (current?.serverId !== this.serverId || !current.takeover) return;
      const { takeover: _t, ...rest } = current;
      this.write({ ...rest, updatedAt: this.now() });
    });
  }

  /** Give the session up (process stopped). */
  release(sessionId: string): void {
    this.held.delete(sessionId);
    this.handledTakeovers.delete(sessionId);
    try {
      withFileLock(this.pathOf(sessionId), () => {
        if (this.read(sessionId)?.serverId === this.serverId) unlinkSync(this.pathOf(sessionId));
      });
    } catch {
      /* folder gone */
    }
  }

  /** Release everything we hold (shutdown; synchronous so it also works in an `exit` hook). */
  releaseAll(): void {
    for (const id of [...this.held.keys()]) this.release(id);
  }

  private write(lease: LeaseInfo): void {
    const path = this.pathOf(lease.sessionId);
    const tmp = `${path}.${process.pid}.${this.serverId}.tmp`;
    writeFileSync(tmp, JSON.stringify(lease));
    renameSync(tmp, path);
  }

  // -------------------------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------------------------

  /**
   * Read every lease: refresh the view of other servers' sessions (report changes), clean up
   * stale leases, and pass take-over requests for our sessions on.
   */
  scan(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      names = [];
    }
    const next = new Map<string, LeaseInfo>();
    const takeovers: string[] = [];
    for (const name of names) {
      const sessionId = name.slice(0, -5);
      const lease = this.read(sessionId);
      if (!lease) continue;
      if (lease.serverId === this.serverId) {
        if (lease.takeover && !this.handledTakeovers.has(sessionId)) takeovers.push(sessionId);
        else if (!lease.takeover) this.handledTakeovers.delete(sessionId);
        continue;
      }
      if (this.registry.isLive(lease.serverId)) {
        next.set(sessionId, lease);
      } else if (this.registry.canJudgeHeartbeats()) {
        this.removeStale(sessionId);
      }
    }
    const changed: string[] = [];
    for (const [id, lease] of next) {
      const old = this.foreign.get(id);
      if (!old || viewKey(old) !== viewKey(lease)) changed.push(id);
    }
    for (const id of this.foreign.keys()) if (!next.has(id)) changed.push(id);
    this.foreign = next;
    if (changed.length) this.options.onForeignChange?.(changed);
    for (const id of takeovers) {
      this.handledTakeovers.add(id);
      this.options.onTakeoverRequest?.(id);
    }
    this.options.onScan?.();
  }

  private dropForeign(sessionId: string): void {
    if (this.foreign.delete(sessionId)) this.options.onForeignChange?.([sessionId]);
  }

  private removeStale(sessionId: string): void {
    try {
      withFileLock(this.pathOf(sessionId), () => {
        const current = this.read(sessionId);
        if (current && current.serverId !== this.serverId && !this.registry.isLive(current.serverId)) unlinkSync(this.pathOf(sessionId));
      });
    } catch {
      /* raced with someone else's cleanup */
    }
  }
}

/** What other servers show about a lease (heartbeat-only rewrites don't count). */
function viewKey(lease: LeaseInfo): string {
  return `${lease.serverId}|${lease.since}|${lease.running}|${lease.pendingInputs}`;
}
