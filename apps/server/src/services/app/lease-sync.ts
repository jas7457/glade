/**
 * Sharing the data folder with other Glade servers (I-062): refusing sessions another server is
 * busy with, handing idle sessions over, taking leases before deletes, forwarding other servers'
 * changes (read from the store's event log, I-121) to our clients, and marking runs interrupted
 * when their server went away.
 */
import type { Session } from "@glade/protocol";
import type { StoreChange } from "../../store/store.js";
import type { AppContext } from "./context.js";
import { ActiveElsewhereError } from "./errors.js";
import type { LivePool } from "./live-pool.js";
import type { Records } from "./records.js";

/** A run whose server went away is marked interrupted after it looked orphaned this long. */
const ORPHAN_GRACE_MS = 1500;

export class LeaseSync {
  /** sessionId -> when its run first looked orphaned (flagged running, no server runs it). */
  private readonly orphanSince = new Map<string, number>();

  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
    private readonly pool: LivePool,
  ) {}

  /**
   * Runs still flagged as in progress at startup were cut off (app quit, crash, server killed).
   * Mark them interrupted; `unread` + `lastRunFailed` make the sidebar show the failed marker.
   */
  recoverInterruptedRuns(): void {
    for (const session of this.ctx.store.listSessions()) {
      if (!session.runInProgress) continue;
      // Still running in another server on this data folder (I-062).
      if (this.ctx.leases?.isLeased(session.id)) continue;
      this.records.saveSession({ ...session, runInProgress: false, interrupted: true, unread: true, lastRunFailed: true });
    }
  }

  /** Take the leases of sessions about to be deleted (all or nothing), so no server still runs them. */
  async takeLeases(sessions: Session[]): Promise<void> {
    const leases = this.ctx.leases;
    if (!leases) return;
    const taken: string[] = [];
    try {
      for (const session of sessions) {
        if (this.ctx.live.has(session.id) || !leases.foreignLeaseNow(session.id)) continue;
        await this.pool.acquireLease(session.id);
        taken.push(session.id);
      }
    } catch (err) {
      for (const id of taken) leases.release(id);
      throw err;
    }
  }

  /** 409 when another server is working on (or waiting for input in) this session right now. */
  assertNotBusyElsewhere(id: string): void {
    if (!this.ctx.leases || this.ctx.live.has(id)) return;
    const lease = this.ctx.leases.foreignLeaseNow(id);
    if (lease && (lease.running || lease.pendingInputs > 0)) throw new ActiveElsewhereError(lease);
  }

  /** Not running here but leased by another live server (I-062). */
  isElsewhere(id: string): boolean {
    return !!this.ctx.leases && !this.ctx.live.has(id) && !this.ctx.opening.has(id) && !!this.ctx.leases.foreignLeaseNow(id);
  }

  /**
   * Another server wants a session we hold (I-062). Hand it over when our process is idle (stop
   * it; closeLive releases the lease); refuse while it's busy or about to be.
   */
  handleTakeoverRequest(id: string): void {
    if (!this.ctx.leases || this.ctx.disposed) return;
    const live = this.ctx.live.get(id);
    if (this.ctx.opening.has(id)) return this.ctx.leases.refuseTakeover(id);
    if (!live) return this.ctx.leases.release(id);
    const busy =
      live.running ||
      live.pendingUi.size > 0 ||
      live.shells.size > 0 ||
      this.ctx.deliveries.has(id) ||
      live.session.getState().isCompacting ||
      (live.awaitingRun && Date.now() - live.lastPromptAt < 5000);
    if (busy) return this.ctx.leases.refuseTakeover(id);
    void this.pool.closeLive(id);
  }

  /**
   * Another server changed the shared files (I-062): push the changes to our clients. Sessions
   * removed there stop here too; a run that ends unread while our clients view it is read.
   */
  applyExternalChange(change: StoreChange): void {
    const { ctx, records } = this;
    if (ctx.disposed) return;
    for (const project of change.projects.upserted) ctx.broadcast({ type: "project_upsert", project });
    for (const projectId of change.projects.removed) ctx.broadcast({ type: "project_removed", projectId });
    const removedWorkspaces = new Set(change.workspaces.removed);
    const touched = new Set<string>(change.workspaces.upserted.map((w) => w.id));
    for (const session of change.sessions.removed) {
      if (ctx.live.has(session.id)) void this.pool.closeLive(session.id);
      ctx.viewers.delete(session.id);
      ctx.agentTimers.clear(session.id);
      ctx.tokens.revoke(session.id);
      if (removedWorkspaces.has(session.workspaceId)) continue;
      ctx.broadcast({ type: "session_removed", sessionId: session.id, workspaceId: session.workspaceId });
      touched.add(session.workspaceId);
    }
    for (const workspaceId of removedWorkspaces) ctx.broadcast({ type: "workspace_removed", workspaceId });
    for (const session of change.sessions.upserted) {
      if (session.unread && !session.markedUnread && ctx.viewers.has(session.id)) {
        records.saveSession({ ...session, unread: false });
        continue;
      }
      ctx.broadcast({ type: "session_upsert", session: records.summarizeSession(session) });
      touched.add(session.workspaceId);
    }
    for (const workspaceId of touched) {
      const workspace = removedWorkspaces.has(workspaceId) ? undefined : ctx.store.getWorkspace(workspaceId);
      if (workspace) ctx.broadcast({ type: "workspace_upsert", workspace: records.summarizeWorkspace(workspace) });
    }
    if (change.settings) ctx.broadcast({ type: "settings", settings: ctx.store.getSettings() });
  }

  /**
   * Runs flagged in progress that no server runs any more (their server quit or crashed while
   * we kept going) are interrupted, like at startup. Waits a moment to rule out a handover.
   */
  checkOrphanedRuns(): void {
    const leases = this.ctx.leases;
    if (!leases || this.ctx.disposed) return;
    const now = Date.now();
    const seen = new Set<string>();
    for (const session of this.ctx.store.listSessions()) {
      if (!session.runInProgress || this.ctx.live.has(session.id) || this.ctx.opening.has(session.id)) continue;
      if (leases.foreignLease(session.id)) continue;
      seen.add(session.id);
      const since = this.orphanSince.get(session.id) ?? now;
      this.orphanSince.set(session.id, since);
      if (now - since < ORPHAN_GRACE_MS || leases.isLeased(session.id)) continue;
      this.orphanSince.delete(session.id);
      this.records.saveSession({ ...session, runInProgress: false, interrupted: true, unread: true, lastRunFailed: true });
    }
    for (const id of [...this.orphanSince.keys()]) if (!seen.has(id)) this.orphanSince.delete(id);
  }
}
