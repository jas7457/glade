/**
 * Conversations in the store (I-121): importing them from the harness's own files and reading
 * them for everything that doesn't need a running agent.
 *
 * - **Import.** `AgentHarness.readTranscript` (pi: its JSONL via `transcriptFromPiSession`) is an
 *   import source only. A session is imported when it's opened, read (search text, chat tools,
 *   titles, dormant sub-agents), after its process stops here, or by the background job started
 *   at launch (every session, oldest first). The harness file's mtime/size (`statSession`) is
 *   recorded only by an import/merge; when it differs later (Glade's own runs, or pi resumed in a
 *   terminal) the file is merged in again: missing turns are added, stored messages keep their
 *   ids (`mergeTranscripts`; Glade's own turns match and add nothing). Harness files are only
 *   ever read.
 * - Sessions running here or in another server are never imported (their owner writes them live).
 * - **Reconciling pi's history.** When a session is opened, the store's copy is shown whenever
 *   the store has one; pi's `get_messages` history (`h<i>` ids) is only used for sessions the
 *   store doesn't know and no harness file can provide.
 */
import type { Session, Transcript } from "@glade/protocol";
import type { AgentHarness, SessionTextMessage } from "../../harness/types.js";
import type { AppContext } from "./context.js";

export function statSignature(stat: { mtimeMs: number; size: number }): string {
  return `${Math.round(stat.mtimeMs)}:${stat.size}`;
}

export interface ImportSummary {
  sessions: number;
  imported: number;
  messages: number;
  failed: number;
  ms: number;
}

export class Transcripts {
  private readonly importing = new Map<string, Promise<void>>();
  private job: Promise<ImportSummary> | null = null;

  constructor(private readonly ctx: AppContext) {}

  /** Running here or leased by another server: its owner writes the store. */
  private busy(id: string): boolean {
    return this.ctx.live.has(id) || this.ctx.opening.has(id) || !!this.ctx.leases?.foreignLeaseNow(id);
  }

  private importable(session: Session): AgentHarness | null {
    const harness = this.ctx.harnesses.get(session.harness);
    return harness?.readTranscript && session.sessionRef ? harness : null;
  }

  /**
   * Bring the store's copy of a session up to date with the harness's file (import it, or merge
   * what changed outside Glade). `owned`: the caller holds the session (about to start it).
   * Resolves to the number of messages added.
   */
  ensureImported(session: Session, { owned = false } = {}): Promise<number> {
    const pending = this.importing.get(session.id);
    // A background import may have backed off because the session is being opened: the opener
    // (owned) runs its own after it.
    if (pending) return owned ? pending.then(() => this.ensureImported(session, { owned })) : pending.then(() => 0);
    let added = 0;
    const run = this.importOne(session, owned)
      .then((n) => {
        added = n;
      })
      .catch((err: Error) => this.ctx.options.log?.(`session ${session.id}: import failed: ${err.message}`))
      .finally(() => this.importing.delete(session.id));
    this.importing.set(session.id, run);
    return run.then(() => added);
  }

  private async importOne(session: Session, owned: boolean): Promise<number> {
    const { store } = this.ctx;
    const harness = this.importable(session);
    if (!harness || (!owned && this.busy(session.id))) return 0;
    const ref = session.sessionRef!;
    const info = store.transcriptInfo(session.id);
    let sig: string | null = null;
    if (harness.statSession) {
      const stat = await harness.statSession(ref).catch(() => null);
      if (!stat) return 0; // nothing persisted (yet), or the file is gone: keep what we have
      sig = statSignature(stat);
      // (An empty stored copy is always re-checked: cheap, and heals a signature recorded too early.)
      if (info && info.sourceSig === sig && info.messageCount > 0) return 0;
    } else if (info) {
      return 0; // no change detection: imported once
    }
    const transcript = await harness.readTranscript!(ref).catch(() => null);
    if (!transcript || this.ctx.disposed || store.isClosed || !store.getSession(session.id)) return 0;
    if (!owned && this.busy(session.id)) return 0;
    const result = store.importTranscript(session.id, transcript, { source: harness.id, sig });
    if (info && result.added) this.ctx.options.log?.(`session ${session.id}: added ${result.added} message(s) changed outside Glade`);
    return result.added;
  }

  /**
   * After a process stopped here: merge its file into the store (nothing new for Glade's own
   * turns, which are stored with the same identities) and record the file's signature. The
   * signature is only ever recorded by a merge, so a change made outside Glade meanwhile (e.g.
   * the file replaced while the server restarts) is never marked as seen without being imported.
   */
  async syncAfterStop(sessionId: string): Promise<void> {
    const session = this.ctx.store.getSession(sessionId);
    if (!session || this.ctx.live.has(sessionId) || this.ctx.opening.has(sessionId) || this.ctx.store.isClosed) return;
    await this.ensureImported(session, { owned: true });
  }

  /** The stored conversation of a session no process runs here (imported first when needed). */
  async read(session: Session): Promise<Transcript> {
    await this.ensureImported(session);
    return this.ctx.store.loadTranscript(session.id, { settle: !this.busy(session.id) });
  }

  /** User/assistant text of a session (imported first when needed; live sessions: what's written). */
  async text(session: Session): Promise<SessionTextMessage[]> {
    const live = this.ctx.live.get(session.id);
    if (live) live.writer.flush();
    else await this.ensureImported(session);
    return this.ctx.store.sessionText(session.id);
  }

  /**
   * Import every session's harness file in the background, oldest first, one at a time (the UI
   * keeps working; a chat opened meanwhile is imported on open). Also catches files changed
   * outside Glade since the last start.
   */
  startBackgroundImport(): Promise<ImportSummary> {
    this.job ??= this.backgroundImport();
    return this.job;
  }

  private async backgroundImport(): Promise<ImportSummary> {
    const started = Date.now();
    const summary: ImportSummary = { sessions: 0, imported: 0, messages: 0, failed: 0, ms: 0 };
    const sessions = this.ctx.store
      .listSessions()
      .filter((s) => this.importable(s))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const session of sessions) {
      if (this.ctx.disposed || this.ctx.store.isClosed) break;
      const current = this.ctx.store.getSession(session.id);
      if (!current) continue;
      summary.sessions++;
      const before = this.ctx.store.transcriptInfo(session.id)?.version ?? null;
      try {
        const added = await this.ensureImported(current);
        const after = this.ctx.store.transcriptInfo(session.id)?.version ?? null;
        if (after !== before) summary.imported++;
        summary.messages += added;
      } catch {
        summary.failed++;
      }
      await new Promise((r) => setImmediate(r));
    }
    summary.ms = Date.now() - started;
    if (summary.imported) {
      this.ctx.options.log?.(`imported ${summary.imported} conversation(s), ${summary.messages} message(s), in ${summary.ms} ms`);
    }
    return summary;
  }
}
