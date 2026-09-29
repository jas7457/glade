/**
 * Records, summaries and pushes: looks up projects/workspaces/sessions (404s), turns them into
 * the summaries clients see (live status, leases elsewhere, sub-agent state), and persists +
 * broadcasts them. Every other module saves through here so pushes stay consistent.
 */
import {
  compareSessions,
  deriveChatStatus,
  rollupWorkspace,
  type AgentEvent,
  type Project,
  type Session,
  type SessionSummary,
  type Workspace,
  type WorkspaceSummary,
} from "@glade/protocol";
import type { AgentHarness } from "../../harness/types.js";
import { sessionAgentState, spawnedAgentRef, type AgentRecord } from "../agents.js";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";
import { attentionLine } from "./attention-line.js";

export class Records {
  constructor(private readonly ctx: AppContext) {}

  requireProject(id: string): Project {
    const project = this.ctx.store.getProject(id);
    if (!project) throw new HttpError(404, "Project not found");
    return project;
  }

  requireWorkspace(id: string): Workspace {
    const workspace = this.ctx.store.getWorkspace(id);
    if (!workspace) throw new HttpError(404, "Workspace not found");
    return workspace;
  }

  requireSession(id: string): Session {
    const session = this.ctx.store.getSession(id);
    if (!session) throw new HttpError(404, "Session not found");
    return session;
  }

  /** The harness that runs `session` (I-064); 409 when it isn't installed in this server. */
  requireHarness(session: Session): AgentHarness {
    const harness = this.ctx.harnesses.get(session.harness);
    if (!harness) {
      throw new HttpError(409, `This chat was created with the "${session.harness}" agent, which isn't available in this Glade server`);
    }
    return harness;
  }

  /**
   * Like {@link requireHarness}, for starting or talking to the agent (I-155): 409 when this
   * device doesn't offer the harness (turned off in Settings → Agents, or no longer installed).
   */
  requireOfferedHarness(session: Session): AgentHarness {
    const harness = this.requireHarness(session);
    const { harnesses } = this.ctx;
    if (!harnesses.isEnabled(harness.id)) throw new HttpError(409, `${harness.info.label} is turned off on ${this.ctx.deviceName()}`);
    if (!harnesses.isInstalled(harness)) throw new HttpError(409, `${harness.info.label} isn't installed on ${this.ctx.deviceName()}`);
    return harness;
  }

  /**
   * The session's harness is registered but not offered here (I-155) and it isn't running: its
   * chat is shown from the store without starting the agent.
   */
  isHarnessOff(session: Session): boolean {
    const harness = this.ctx.harnesses.get(session.harness);
    return !!harness && !this.ctx.harnesses.isOffered(harness) && !this.ctx.live.has(session.id) && !this.ctx.opening.has(session.id);
  }

  summarizeSession(session: Session): SessionSummary {
    const live = this.ctx.live.get(session.id);
    // Run by another server (I-062): its lease says whether it's working / waiting for input.
    const elsewhere = live ? null : (this.ctx.leases?.foreignLease(session.id) ?? null);
    const running = live?.running ?? elsewhere?.running ?? false;
    const pendingInputs = live?.pendingUi.size ?? elsewhere?.pendingInputs ?? 0;
    const summary: SessionSummary = { ...session, running, pendingInputs, status: deriveChatStatus({ running, pendingInputs, unread: session.unread }) };
    if (elsewhere && (elsewhere.running || elsewhere.pendingInputs > 0)) {
      summary.activeElsewhere = { serverKind: elsewhere.serverKind, since: elsewhere.since };
    }
    // For notifications (I-135): the question, the error or the reply's last sentence.
    if (live && (pendingInputs > 0 || !running)) {
      const line = attentionLine(live.transcript, live.pendingUi.values(), !!session.lastRunFailed);
      if (line) summary.attentionLine = line;
    }
    const agent = session.kind === "subagent" ? this.ctx.agents.get(session.id) : undefined;
    if (agent) summary.agent = sessionAgentState(agent, running);
    if (session.kind === "main") {
      const spawned = this.ctx.agents.childrenOf(session.id);
      if (spawned.length) summary.spawnedAgents = spawned.map(spawnedAgentRef);
    }
    return summary;
  }

  summarizeWorkspace(workspace: Workspace): WorkspaceSummary {
    return rollupWorkspace(workspace, this.ctx.store.listSessions(workspace.id).map((s) => this.summarizeSession(s)));
  }

  /** Main sessions first, then sub-agents; each by creation. */
  sessionsOf(workspaceId: string): SessionSummary[] {
    const all = this.ctx.store.listSessions(workspaceId).sort(compareSessions);
    return [...all.filter((s) => s.kind === "main"), ...all.filter((s) => s.kind !== "main")].map((s) => this.summarizeSession(s));
  }

  /** Persist + push a workspace (with its rolled-up status). */
  saveWorkspace(workspace: Workspace): WorkspaceSummary {
    this.ctx.store.upsertWorkspace(workspace);
    const summary = this.summarizeWorkspace(workspace);
    this.ctx.broadcast({ type: "workspace_upsert", workspace: summary });
    return summary;
  }

  /** Push the workspace again because one of its sessions changed. `touch` bumps its activity. */
  refreshWorkspace(workspaceId: string, touch = false): void {
    const workspace = this.ctx.store.getWorkspace(workspaceId);
    if (!workspace) return;
    this.saveWorkspace(touch ? { ...workspace, lastActivityAt: Date.now() } : workspace);
  }

  /** Persist + push a session, then its workspace (status roll-up). */
  saveSession(session: Session, { touch = false } = {}): SessionSummary {
    this.ctx.store.upsertSession(session);
    this.syncLease(session.id);
    const summary = this.summarizeSession(session);
    this.ctx.broadcast({ type: "session_upsert", session: summary });
    this.refreshWorkspace(session.workspaceId, touch);
    return summary;
  }

  /** Tell other servers whether this session is working / waiting for input (its lease). */
  syncLease(id: string): void {
    const live = this.ctx.live.get(id);
    if (live && this.ctx.leases) this.ctx.leases.setState(id, { running: live.running, pendingInputs: live.pendingUi.size });
  }

  emitSessionEvent(session: Pick<Session, "id" | "workspaceId">, event: AgentEvent): void {
    this.ctx.broadcast({ type: "session_event", sessionId: session.id, workspaceId: session.workspaceId, event });
  }

  /** Push sessions again (and their workspaces) because something outside our records changed. */
  pushSessions(ids: string[]): void {
    if (this.ctx.disposed) return;
    const workspaces = new Set<string>();
    for (const id of ids) {
      const session = this.ctx.store.getSession(id);
      if (!session) continue;
      this.ctx.broadcast({ type: "session_upsert", session: this.summarizeSession(session) });
      workspaces.add(session.workspaceId);
    }
    for (const wid of workspaces) {
      const workspace = this.ctx.store.getWorkspace(wid);
      if (workspace) this.ctx.broadcast({ type: "workspace_upsert", workspace: this.summarizeWorkspace(workspace) });
    }
  }

  touchProject(projectId: string | null): void {
    if (!projectId) return;
    const project = this.ctx.store.getProject(projectId);
    if (!project) return;
    const next = { ...project, lastActivityAt: Date.now() };
    this.ctx.store.upsertProject(next);
    this.ctx.broadcast({ type: "project_upsert", project: next });
  }

  async renameSession(session: Session, title: string): Promise<void> {
    this.saveSession({ ...session, title, titleSource: "user" });
    await this.ctx.live.get(session.id)?.session.setTitle(title).catch(() => {});
  }

  /** A closed sub-agent without a running process (viewing it shouldn't start one). */
  isDormantAgent(id: string): boolean {
    return !!this.ctx.agents.get(id)?.closed && !this.ctx.live.has(id) && !this.ctx.opening.has(id);
  }

  /** Update a sub-agent's record and push its session (the browser shows its state, I-054). */
  updateAgent(sessionId: string, patch: Partial<AgentRecord>): AgentRecord | undefined {
    const record = this.ctx.agents.update(sessionId, patch);
    const session = this.ctx.store.getSession(sessionId);
    if (record && session) this.saveSession(session);
    return record;
  }

  /** Drop a deleted session's sub-agent record (tokens go with its process). */
  forgetAgent(sessionId: string): void {
    this.ctx.agentTimers.clear(sessionId);
    this.ctx.tokens.revoke(sessionId);
    this.ctx.agents.remove(sessionId);
  }
}
