/**
 * Sessions (a workspace's tabs, and sub-agents' sessions): create, list, read (live, or from the
 * session file for closed sub-agents and sessions another server runs), update, delete (with
 * everything they spawned), and read-only access for chat tools (I-091).
 */
import { randomUUID } from "node:crypto";
import {
  activeMainSessionId,
  defaultSessionState,
  emptyTranscript,
  quickTitle,
  type CreateSessionRequest,
  type Session,
  type SessionDetail,
  type SessionState,
  type SessionSummary,
  type TranscriptPage,
  type UpdateSessionRequest,
  type Workspace,
} from "@glade/protocol";
import type { SessionText } from "../../harness/types.js";
import type { AgentIdentity } from "../agent-names.js";
import { exitedText } from "../agents.js";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";
import type { LeaseSync } from "./lease-sync.js";
import type { LivePool } from "./live-pool.js";
import type { Records } from "./records.js";
import type { SessionActions } from "./session-actions.js";
import type { Transcripts } from "./transcripts.js";
import { pageOf } from "../../store/store.js";
import type { SessionSyncView } from "../sync/hub.js";

/**
 * How a session is created. `subagent` sessions are for the agent API (I-037); `register` runs
 * once the session record exists, before its agent starts (the agent API records the sub-agent
 * there so the process starts with its role).
 */
export type NewSessionKind =
  | { kind: "main" }
  | {
      kind: "subagent";
      parentSessionId: string;
      agentName: string;
      /** Fun name + colour (I-084). */
      identity?: AgentIdentity;
      register?: (session: Session) => void;
    };

/** What sessions need from the agent API, wired by `AppService`. */
export interface SessionsHooks {
  /** Queue a prompt to a session (a sub-agent's exit notice to its parent). */
  deliver(targetId: string, text: string, behavior: "steer" | "followUp"): void;
}

export class Sessions {
  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
    private readonly pool: LivePool,
    private readonly leaseSync: LeaseSync,
    private readonly actions: SessionActions,
    private readonly transcripts: Transcripts,
    private readonly hooks: SessionsHooks,
  ) {}

  /** All sessions (or one workspace's), main sessions first. */
  listSessions(workspaceId?: string): SessionSummary[] {
    if (workspaceId !== undefined) {
      this.records.requireWorkspace(workspaceId);
      return this.records.sessionsOf(workspaceId);
    }
    return this.ctx.store.listWorkspaces().flatMap((w) => this.records.sessionsOf(w.id));
  }

  /**
   * A session's conversation as plain user/assistant text, from the store without starting an
   * agent (chat tools, I-091; imported from the harness's file first if needed, I-121). `null`
   * when there's nothing stored (yet).
   */
  async readSessionText(sessionId: string): Promise<SessionText | null> {
    const session = this.records.requireSession(sessionId);
    const messages = await this.transcripts.text(session);
    if (!messages.length && !this.ctx.store.hasTranscript(session.id)) return null;
    return { name: null, messages };
  }

  /**
   * Ask every connected window to show a session, like a ⌘K pick (`open_chat` push, I-091).
   * Returns how many clients were told.
   */
  requestOpenChat(sessionId: string): number {
    const session = this.records.requireSession(sessionId);
    this.ctx.broadcast({ type: "open_chat", workspaceId: session.workspaceId, sessionId: session.id, sessionKind: session.kind });
    return this.ctx.listeners.size;
  }

  /**
   * Add a session to a workspace and start its agent (plus the first prompt, if given). Main
   * sessions are tabs the user opens; `subagent` sessions are spawned by another session of the
   * same workspace (agent API, I-037).
   */
  async createSession(workspaceId: string, req: CreateSessionRequest, how: NewSessionKind = { kind: "main" }): Promise<SessionDetail> {
    const { records } = this;
    const workspace = records.requireWorkspace(workspaceId);
    if (how.kind === "subagent") {
      const parent = records.requireSession(how.parentSessionId);
      if (parent.workspaceId !== workspaceId) throw new HttpError(400, "The parent session belongs to another workspace");
    }
    const settings = this.ctx.store.getSettings();
    // Sub-agents run in their parent's harness; other new sessions in the chosen one, else the
    // harness of the workspace's focused tab (a new tab keeps the chat's agent), else the default.
    const harness =
      how.kind === "subagent"
        ? records.requireHarness(records.requireSession(how.parentSessionId))
        : req.harness
          ? this.ctx.harnesses.get(req.harness)
          : this.workspaceHarness(workspace);
    if (!harness) throw new HttpError(400, `The agent "${req.harness}" isn't installed`);
    // Harnesses without Glade's model picker (ACP agents, I-119) choose their own model.
    const usesModels = harness.info.capabilities.models !== false;
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      workspaceId,
      kind: how.kind,
      parentSessionId: how.kind === "subagent" ? how.parentSessionId : null,
      agentName: how.kind === "subagent" ? how.agentName : null,
      ...(how.kind === "subagent" && how.identity ? { agentDisplayName: how.identity.displayName, agentColor: how.identity.color } : {}),
      title: how.kind === "subagent" ? how.agentName : req.prompt ? quickTitle(req.prompt) : "New chat",
      titleSource: how.kind === "subagent" ? "user" : "auto",
      harness: harness.id,
      sessionRef: null,
      unread: false,
      createdAt: now,
      lastActivityAt: now,
      model: usesModels ? (req.model ?? settings.models.defaultModel) : null,
      thinkingLevel: usesModels ? (req.thinkingLevel ?? settings.models.defaultThinkingLevel) : null,
    };
    records.saveSession(session);
    if (how.kind === "subagent") how.register?.(session);
    try {
      const live = await this.pool.ensureLive(session.id);
      if (req.prompt?.trim() || req.images?.length) {
        await this.actions.sendPrompt(session.id, { text: req.prompt ?? "", images: req.images }, live);
      }
    } catch (err) {
      await this.pool.disposeSession(this.ctx.store.getSession(session.id) ?? session).catch(() => {});
      records.forgetAgent(session.id);
      this.ctx.store.removeSession(session.id);
      this.ctx.broadcast({ type: "session_removed", sessionId: session.id, workspaceId });
      records.refreshWorkspace(workspaceId);
      throw err;
    }
    return this.getSessionDetail(session.id);
  }

  /** The harness of a workspace's focused main tab when it's installed, else the default one. */
  private workspaceHarness(workspace: Workspace) {
    const focused = activeMainSessionId(workspace, this.ctx.store.listSessions(workspace.id));
    const harness = focused ? this.ctx.store.getSession(focused)?.harness : undefined;
    return (harness ? this.ctx.harnesses.get(harness) : undefined) ?? this.ctx.harnesses.default();
  }

  async getSessionDetail(id: string): Promise<SessionDetail> {
    // Everything up to this seq is in the detail (later changes are replayed after it, I-122).
    const seq = this.ctx.store.headSeq;
    const session = this.records.requireSession(id);
    const offline = (await this.closedAgentDetail(session)) ?? (await this.elsewhereDetail(session));
    if (offline) return { ...offline, seq };
    const live = await this.pool.ensureLive(id);
    return {
      session: this.records.summarizeSession(this.records.requireSession(id)),
      transcript: live.transcript,
      state: { ...live.session.getState(), runStartedAt: live.running ? live.runStartedAt : null },
      pendingUiRequests: [...live.pendingUi.values()],
      seq,
    };
  }

  /**
   * Get a session ready for a sync subscription (I-122), deciding like {@link getSessionDetail}
   * (closed sub-agents and sessions another server holds aren't started). Resolves to a
   * synchronous reader of the current state that first writes pending transcript changes.
   */
  async prepareSync(id: string): Promise<() => SessionSyncView> {
    const session = this.records.requireSession(id);
    const dormant = this.records.isDormantAgent(id) ? await this.transcripts.read(session).then(() => this.ctx.store.hasTranscript(id)) : false;
    const elsewhere = !dormant && !!this.ctx.leases && !this.ctx.live.has(id) && !this.ctx.opening.has(id) && !!this.ctx.leases.foreignLeaseNow(id);
    if (!dormant && !elsewhere) await this.pool.ensureLive(id);
    const offlineState = dormant || elsewhere || !this.ctx.live.has(id) ? await this.offlineState(session) : null;
    return () => {
      const live = this.ctx.live.get(id);
      if (live) {
        live.writer.flush();
        return {
          transcript: live.transcript,
          state: { ...live.session.getState(), runStartedAt: live.running ? live.runStartedAt : null },
          pendingUiRequests: [...live.pendingUi.values()],
        };
      }
      const { store } = this.ctx;
      const current = store.getSession(id) ?? session;
      const running = this.records.summarizeSession(current).running;
      const transcript = store.hasTranscript(id) ? store.loadTranscript(id, { settle: !running }) : emptyTranscript();
      return {
        transcript,
        state: { ...(offlineState ?? defaultSessionState()), isRunning: running },
        pendingUiRequests: [],
        offline: true,
      };
    };
  }

  /** Earlier turns of a transcript ("load earlier", I-122): the newest `turns` turns before index `before`. */
  async transcriptPage(id: string, before: number | undefined, turns: number): Promise<TranscriptPage> {
    const session = this.records.requireSession(id);
    const live = this.ctx.live.get(id);
    return pageOf(live ? live.transcript : await this.transcripts.read(session), { before, turns });
  }

  /**
   * A closed sub-agent (its process crashed or stopped) is shown from the store without starting
   * it again (I-054); typing in it starts it. `null` when it should be started as usual.
   */
  private async closedAgentDetail(session: Session): Promise<SessionDetail | null> {
    if (!this.records.isDormantAgent(session.id)) return null;
    const transcript = await this.transcripts.read(session);
    if (!this.ctx.store.hasTranscript(session.id)) return null;
    const state = await this.offlineState(session);
    return { session: this.records.summarizeSession(session), transcript, state, pendingUiRequests: [], offline: true };
  }

  /**
   * State of a session that isn't running here: its model and thinking level, with the model's
   * thinking levels from the harness's model list so the composer can still offer them (I-102).
   */
  private async offlineState(session: Session): Promise<SessionState> {
    const models = session.model ? await this.ctx.harnesses.get(session.harness)?.listModels().catch(() => null) : null;
    const info = session.model ? models?.find((m) => m.provider === session.model!.provider && m.id === session.model!.id) : undefined;
    return {
      ...defaultSessionState(),
      model: session.model,
      ...(session.thinkingLevel ? { thinkingLevel: session.thinkingLevel } : {}),
      ...(info ? { thinkingLevels: info.thinkingLevels } : {}),
    };
  }

  /**
   * A session another server runs (I-062) is shown from the store, which that server keeps
   * current while it runs (I-121); viewing it doesn't take it over (typing in it does, once it's
   * idle there). `null` when it isn't leased elsewhere.
   */
  private async elsewhereDetail(session: Session): Promise<SessionDetail | null> {
    if (!this.ctx.leases || this.ctx.live.has(session.id) || this.ctx.opening.has(session.id)) return null;
    if (!this.ctx.leases.foreignLeaseNow(session.id)) return null;
    const transcript = this.ctx.store.hasTranscript(session.id) ? this.ctx.store.loadTranscript(session.id) : emptyTranscript();
    const summary = this.records.summarizeSession(session);
    const state = { ...(await this.offlineState(session)), isRunning: summary.running };
    return { session: summary, transcript, state, pendingUiRequests: [], offline: true };
  }

  async updateSession(id: string, req: UpdateSessionRequest): Promise<SessionSummary> {
    let session = this.records.requireSession(id);
    if (req.title !== undefined) {
      const title = req.title.trim();
      if (!title) throw new HttpError(400, "Title cannot be empty");
      await this.records.renameSession(session, title);
      session = this.records.requireSession(id);
    }
    const next: Session = { ...session };
    if (req.unread !== undefined) {
      next.unread = req.unread;
      // I-073: a manual mark survives while the chat stays on screen (in this or another server).
      if (req.unread) next.markedUnread = true;
      else delete next.markedUnread;
    }
    if (req.interrupted === false) delete next.interrupted;
    return this.records.saveSession(next);
  }

  /**
   * Close a tab: stops the agent and permanently deletes the session file, plus any sub-agents
   * it spawned. The last main session can't be deleted (delete the workspace instead).
   */
  async deleteSession(id: string): Promise<void> {
    const { ctx } = this;
    const session = this.records.requireSession(id);
    const siblings = ctx.store.listSessions(session.workspaceId);
    if (session.kind === "main" && siblings.filter((s) => s.kind === "main").length <= 1) {
      throw new HttpError(409, "A workspace needs at least one main session; delete the workspace instead");
    }
    const doomed = [session, ...this.descendantsOf(session.id, siblings)];
    const doomedIds = new Set(doomed.map((s) => s.id));
    await this.leaseSync.takeLeases(doomed);
    for (const s of doomed) {
      await this.pool.disposeSession(s);
      const agent = ctx.agents.get(s.id);
      if (agent && !doomedIds.has(agent.parentSessionId)) {
        if (!agent.closed && agent.doneAt === null) {
          this.hooks.deliver(agent.parentSessionId, exitedText(agent, "Exited before calling report_done (the user closed its tab)."), "followUp");
        }
        // Its parent keeps seeing it as closed (list_agents; close_agent says "already closed").
        ctx.agentTimers.clear(s.id);
        ctx.tokens.revoke(s.id);
        ctx.agents.update(s.id, { closing: false, closed: true, removed: true });
      } else {
        this.records.forgetAgent(s.id);
      }
      ctx.store.removeSession(s.id);
      ctx.broadcast({ type: "session_removed", sessionId: s.id, workspaceId: s.workspaceId });
    }
    ctx.agents.removeWhere((r) => doomedIds.has(r.parentSessionId));
    this.records.refreshWorkspace(session.workspaceId);
  }

  /** Sub-agents spawned by `id`, recursively. */
  private descendantsOf(id: string, sessions: Session[]): Session[] {
    const children = sessions.filter((s) => s.parentSessionId === id);
    return children.flatMap((c) => [c, ...this.descendantsOf(c.id, sessions)]);
  }
}
