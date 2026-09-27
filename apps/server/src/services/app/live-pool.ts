/**
 * The live session pool: one agent process per session. Starts processes (claiming the
 * session's lease first, I-062), turns their events into transcript/status updates and pushes,
 * tracks open dialogs, handles exits and crashes, stops processes and evicts idle ones.
 */
import { mkdirSync } from "node:fs";
import {
  AGENT_ENV,
  LEGACY_AGENT_ENV,
  applyAgentEvent,
  sameModel,
  type AgentEvent,
  type Session,
  type UiRequest,
  type Workspace,
} from "@glade/protocol";
import type { AgentHarness, HarnessSession } from "../../harness/types.js";
import { exitedText } from "../agents.js";
import type { AppContext, LiveSession } from "./context.js";
import { ActiveElsewhereError } from "./errors.js";
import type { Records } from "./records.js";

/** What the pool needs from the agent API (sub-agents, I-037), wired by `AppService`. */
export interface LivePoolHooks {
  /** Close a sub-agent for good (at the end of the turn it was asked to close in). */
  closeAgentSession(sessionId: string): Promise<void>;
  /** Queue a prompt to a session (a sub-agent's exit notice to its parent). */
  deliver(targetId: string, text: string, behavior: "steer" | "followUp"): void;
}

export class LivePool {
  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
    private readonly hooks: LivePoolHooks,
  ) {}

  /** Number of agent processes currently alive (for tests/diagnostics). */
  get liveCount(): number {
    return this.ctx.live.size;
  }

  ensureLive(id: string): Promise<LiveSession> {
    const { live, leases, opening } = this.ctx;
    const existing = live.get(id);
    // Our lease can only be lost if another server judged us gone (e.g. we hung); then restart.
    const lost = !!existing && !!leases && !leases.holds(id);
    if (existing && !lost) {
      existing.lastUsedAt = Date.now();
      return Promise.resolve(existing);
    }
    let pending = opening.get(id);
    if (!pending) {
      pending = (async () => {
        if (lost) await this.closeLive(id);
        return this.openLive(id);
      })().finally(() => opening.delete(id));
      opening.set(id, pending);
    }
    return pending;
  }

  /**
   * Claim the session's lease before starting its process (I-062). Waits briefly for another
   * server to hand over an idle session; a session it's busy with fails with 409.
   */
  async acquireLease(id: string): Promise<void> {
    if (!this.ctx.leases) return;
    const blocking = await this.ctx.leases.acquire(id);
    if (blocking) throw new ActiveElsewhereError(blocking);
  }

  private async openLive(id: string): Promise<LiveSession> {
    const record = this.records.requireSession(id);
    const workspace = this.records.requireWorkspace(record.workspaceId);
    const harness = this.records.requireHarness(record);
    await this.acquireLease(id);
    try {
      return await this.startLive(id, record, workspace, harness);
    } catch (err) {
      if (!this.ctx.live.has(id)) this.ctx.leases?.release(id);
      throw err;
    }
  }

  private async startLive(id: string, record: Session, workspace: Workspace, harness: AgentHarness): Promise<LiveSession> {
    mkdirSync(workspace.cwd, { recursive: true });
    const agent = this.ctx.agents.get(id);
    let session: HarnessSession;
    try {
      session = await harness.openSession({
        cwd: workspace.cwd,
        sessionRef: record.sessionRef,
        model: record.model,
        thinkingLevel: record.thinkingLevel,
        env: this.agentEnv(record),
        ...(agent ? { appendSystemPrompt: agent.systemPrompt, ...(agent.tools ? { tools: agent.tools } : {}) } : {}),
      });
    } catch (err) {
      this.ctx.tokens.revoke(id);
      throw err;
    }
    const transcript = await session.loadTranscript();
    const live: LiveSession = {
      harness,
      session,
      transcript,
      pendingUi: new Map(),
      uiTimers: new Map(),
      running: session.getState().isRunning,
      runStartedAt: session.getState().isRunning ? Date.now() : null,
      lastUsedAt: Date.now(),
      lastPromptAt: 0,
      awaitingRun: false,
      shells: new Set(),
      unsubscribe: () => {},
    };
    const offEvent = session.onEvent((event) => this.handleEvent(id, live, event));
    const offExit = session.onExit((error) => this.handleExit(id, live, error));
    live.unsubscribe = () => {
      offEvent();
      offExit();
    };
    this.ctx.live.set(id, live);

    // Persist the session reference / effective model once known.
    const state = session.getState();
    const current = this.records.requireSession(id);
    if (current.sessionRef !== session.sessionRef || !current.model) {
      this.records.saveSession({
        ...current,
        sessionRef: session.sessionRef ?? current.sessionRef,
        model: current.model ?? state.model,
        thinkingLevel: current.thinkingLevel ?? state.thinkingLevel,
      });
    }
    if (current.titleSource === "user" || current.title !== "New chat") {
      await session.setTitle(current.title).catch(() => {});
    }
    // Never evict the session we just opened for the caller.
    this.evictIdle(id);
    return live;
  }

  /**
   * Environment for a session's new agent process: its identity for the agent API, under the
   * `GLADE_*` names and (for older agent-teams versions) the pre-rename `PI_UI_*` ones.
   */
  private agentEnv(session: Session): Record<string, string> {
    if (!this.ctx.serverUrl) return {};
    const values: Partial<Record<keyof typeof AGENT_ENV, string>> = {
      url: this.ctx.serverUrl,
      sessionId: session.id,
      token: this.ctx.tokens.issue(session.id),
    };
    const agent = this.ctx.agents.get(session.id);
    if (agent) values.agentName = agent.name;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(values) as Array<[keyof typeof AGENT_ENV, string]>) {
      env[AGENT_ENV[key]] = value;
      env[LEGACY_AGENT_ENV[key]] = value;
    }
    return env;
  }

  private handleEvent(id: string, live: LiveSession, rawEvent: AgentEvent): void {
    const event = stampEvent(rawEvent);
    live.transcript = applyAgentEvent(live.transcript, event);
    if (event.type === "run_start") {
      live.running = true;
      live.runStartedAt = event.at ?? Date.now();
    }
    if (event.type === "run_end") {
      live.running = false;
      live.runStartedAt = null;
    }
    if (event.type === "run_start" || event.type === "run_end") live.awaitingRun = false;
    if (event.type === "shell_start") live.shells.add(event.id);
    if (event.type === "shell_end") {
      live.shells.delete(event.id);
      live.lastUsedAt = Date.now();
    }
    if (event.type === "ui_request") this.addPendingUi(id, live, event.request);
    if (event.type === "ui_request_closed") this.removePendingUi(live, event.id);

    const session = this.ctx.store.getSession(id);
    if (!session) return;
    this.records.emitSessionEvent(session, event);

    if (event.type === "run_start") {
      const next: Session = { ...session, lastActivityAt: Date.now(), lastRunFailed: false, runInProgress: true };
      delete next.interrupted;
      this.records.saveSession(next, { touch: true });
    } else if (event.type === "run_end") {
      this.ctx.options.onRunEnd?.(id);
      this.ctx.usage?.onRunEnd();
      this.clearPendingUi(live);
      live.lastUsedAt = Date.now();
      this.records.saveSession(
        { ...session, lastActivityAt: Date.now(), runInProgress: false, unread: session.unread || !this.ctx.viewers.has(id) },
        { touch: true },
      );
      if (this.ctx.agents.get(id)?.closing) void this.hooks.closeAgentSession(id);
      this.evictIdle();
    } else if (event.type === "ui_request" || event.type === "ui_request_closed") {
      this.records.saveSession(session); // pendingInputs/status changed
    } else if (
      (event.type === "error" || (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error")) &&
      !session.lastRunFailed
    ) {
      this.records.saveSession({ ...session, lastRunFailed: true });
    } else if (event.type === "state" && (event.state.model || event.state.thinkingLevel)) {
      const next = {
        ...session,
        model: event.state.model ?? session.model,
        thinkingLevel: event.state.thinkingLevel ?? session.thinkingLevel,
      };
      const modelChanged = next.model !== session.model && !sameModel(next.model, session.model);
      if (modelChanged || next.thinkingLevel !== session.thinkingLevel) this.records.saveSession(next);
    }
  }

  private addPendingUi(sessionId: string, live: LiveSession, request: UiRequest): void {
    live.pendingUi.set(request.id, request);
    if (request.timeoutMs === undefined) return;
    // The agent auto-resolves timed-out dialogs without telling us; don't stay "blocked" forever.
    const timer = setTimeout(() => {
      live.uiTimers.delete(request.id);
      if (!live.pendingUi.delete(request.id) || this.ctx.live.get(sessionId) !== live) return;
      const session = this.ctx.store.getSession(sessionId);
      if (!session) return;
      this.records.emitSessionEvent(session, { type: "ui_request_closed", id: request.id });
      this.records.saveSession(session);
    }, request.timeoutMs);
    timer.unref();
    live.uiTimers.set(request.id, timer);
  }

  removePendingUi(live: LiveSession, requestId: string): boolean {
    const timer = live.uiTimers.get(requestId);
    if (timer) clearTimeout(timer);
    live.uiTimers.delete(requestId);
    return live.pendingUi.delete(requestId);
  }

  private clearPendingUi(live: LiveSession): void {
    for (const timer of live.uiTimers.values()) clearTimeout(timer);
    live.uiTimers.clear();
    live.pendingUi.clear();
  }

  private handleExit(id: string, live: LiveSession, error: Error | null): void {
    if (this.ctx.live.get(id) !== live) return;
    this.clearPendingUi(live);
    live.unsubscribe();
    this.ctx.live.delete(id);
    this.ctx.tokens.revoke(id);
    const wasRunning = live.running;
    const session = this.ctx.store.getSession(id);
    if (!session) {
      this.ctx.leases?.release(id);
      return;
    }
    const agent = this.ctx.agents.get(id);
    if (agent && !agent.closed) {
      this.ctx.agentTimers.clear(id);
      this.ctx.agents.update(id, { closed: true, closing: false }); // pushed with the session below
      if (agent.doneAt === null) {
        this.hooks.deliver(agent.parentSessionId, exitedText(agent.name, "Process ended without calling report_done (crashed)."), "followUp");
      }
    }
    if (error) {
      this.ctx.options.log?.(`session ${id}: agent exited: ${error.message}`);
      this.records.emitSessionEvent(session, { type: "error", message: error.message });
    }
    if (error || wasRunning) {
      this.records.emitSessionEvent(session, { type: "state", state: { isRunning: false } });
      this.records.emitSessionEvent(session, { type: "run_end" });
      // A crash ends the run: flag it, and mark unread like any run that ends off screen.
      // Dying mid-run also means the work was cut off.
      const unread = session.unread || !this.ctx.viewers.has(id);
      const next: Session = { ...session, lastRunFailed: true, unread, runInProgress: false };
      if (wasRunning || session.runInProgress) next.interrupted = true;
      this.records.saveSession(next);
    } else {
      this.records.saveSession(session);
    }
    this.releaseLease(id);
  }

  /** Give a session's lease back once its process is gone; its record is written first. */
  private releaseLease(id: string): void {
    if (!this.ctx.leases) return;
    this.ctx.store.flush();
    this.ctx.leases.release(id);
  }

  /**
   * Stop a session's agent process. Unless `quiet` (server shutdown: the run stays flagged so
   * it shows as interrupted next start), clients are told it stopped: events after this point are
   * no longer forwarded, so without a final `state`/`run_end` a tab would stay on "Working…".
   */
  async closeLive(id: string, { quiet = false } = {}): Promise<void> {
    const live = this.ctx.live.get(id);
    if (!live) return;
    const dialogs = [...live.pendingUi.keys()];
    this.clearPendingUi(live);
    live.unsubscribe();
    this.ctx.live.delete(id);
    this.ctx.tokens.revoke(id);
    const session = this.ctx.store.getSession(id);
    if (session && !quiet) {
      for (const dialog of dialogs) this.records.emitSessionEvent(session, { type: "ui_request_closed", id: dialog });
      if (live.running) this.records.emitSessionEvent(session, { type: "run_end" });
      this.records.emitSessionEvent(session, { type: "state", state: { isRunning: false } });
      if (live.running || dialogs.length || session.runInProgress) this.records.saveSession({ ...session, runInProgress: false });
    }
    await live.session.dispose();
    // Only if no new process started meanwhile (e.g. reopened right away).
    if (!this.ctx.live.has(id) && !this.ctx.opening.has(id)) this.releaseLease(id);
  }

  /** Stop a session's agent and delete its file (the record is left to the caller). */
  async disposeSession(session: Session): Promise<void> {
    await this.closeLive(session.id);
    const harness = this.ctx.harnesses.get(session.harness);
    if (session.sessionRef && harness) await harness.deleteSession(session.sessionRef).catch(() => {});
    else if (session.sessionRef) this.ctx.options.log?.(`kept the session file of ${session.id}: its harness "${session.harness}" isn't installed`);
    this.ctx.viewers.delete(session.id);
    this.ctx.leases?.release(session.id);
    await this.ctx.attachments.removeSession(session.id).catch(() => {});
  }

  /** Keep at most `maxIdleProcesses` idle sessions alive (least recently used go first). */
  private evictIdle(keepId?: string): void {
    const max = this.ctx.store.getSettings().agent.maxIdleProcesses;
    const idle = [...this.ctx.live.entries()]
      .filter(([id, l]) => id !== keepId && !l.running && l.pendingUi.size === 0 && l.shells.size === 0 && !this.ctx.viewers.has(id))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const excess = idle.length - max;
    for (let i = 0; i < excess; i++) void this.closeLive(idle[i]![0]);
  }
}

/** Timing stamps on run/tool/shell events (I-070): harnesses don't send them, the server adds them once. */
function stampEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case "run_start":
    case "tool_start":
    case "tool_end":
    case "shell_start": // I-076
    case "shell_end":
      return event.at === undefined ? { ...event, at: Date.now() } : event;
    default:
      return event;
  }
}
