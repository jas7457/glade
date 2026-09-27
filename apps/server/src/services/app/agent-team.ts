/**
 * The agent API (I-037): sub-agents as `subagent` sessions (see http/agents.ts). Spawning,
 * messaging, listing, closing and `report_done`, plus the per-target delivery queue that turns
 * agent messages into prompts (retried while the target runs in another server, I-062).
 */
import {
  MAX_ACTIVE_AGENTS,
  THINKING_LEVELS,
  sameModel,
  type CloseAgentResponse,
  type ListAgentsResponse,
  type MessageAgentRequest,
  type ModelInfo,
  type ModelRef,
  type ReportDoneRequest,
  type ReportDoneResponse,
  type Session,
  type SpawnAgentRequest,
  type SpawnAgentResponse,
  type ThinkingLevel,
} from "@glade/protocol";
import type { AgentHarness } from "../../harness/types.js";
import { pickAgentIdentity } from "../agent-names.js";
import {
  CLOSE_GRACE_MS,
  IDLE_CLOSE_MS,
  MAIN_AGENT,
  agentInfo,
  buildRolePrompt,
  doneText,
  messageText,
  normalizeAgentName,
  type AgentRecord,
} from "../agents.js";
import type { AppContext } from "./context.js";
import { ActiveElsewhereError, HttpError } from "./errors.js";
import type { LivePool } from "./live-pool.js";
import type { Records } from "./records.js";
import type { SessionActions } from "./session-actions.js";
import type { Sessions } from "./sessions.js";

/** Deliveries to a session busy in another server are retried this long. */
const ELSEWHERE_RETRY_MS = 30 * 60_000;

export class AgentTeam {
  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
    private readonly pool: LivePool,
    private readonly actions: SessionActions,
    private readonly sessions: Sessions,
  ) {}

  /** The session a token belongs to (401 for unknown, revoked or stale tokens). */
  authenticateAgent(token: string | undefined): Session {
    const sessionId = token ? this.ctx.tokens.sessionFor(token) : undefined;
    const session = sessionId ? this.ctx.store.getSession(sessionId) : undefined;
    if (!session) throw new HttpError(401, "Invalid agent token");
    return session;
  }

  /** Start a sub-agent in the caller's workspace (same folder); its first prompt is the task. */
  async spawnAgent(callerId: string, req: SpawnAgentRequest): Promise<SpawnAgentResponse> {
    const { ctx } = this;
    const caller = this.records.requireSession(callerId);
    if (caller.kind !== "main") throw new HttpError(403, "Sub-agents can't spawn agents");
    if (!ctx.store.getSettings().agent.subagents) {
      throw new HttpError(403, "Sub-agents are turned off in Glade (Settings → Agent → Use sub-agents). Do the work yourself.");
    }
    const name = normalizeAgentName(req.name ?? "");
    if (!name || name === MAIN_AGENT) throw new HttpError(400, `Invalid agent name "${req.name}"`);
    const task = req.task?.trim();
    if (!task) throw new HttpError(400, "task is required");
    const keepOpenReason = req.keepOpenReason?.trim() || null;
    if (req.keepOpen && !keepOpenReason) {
      throw new HttpError(400, "keep_open needs keep_open_reason: name the concrete follow-up you expect to send. If there isn't one, omit keep_open.");
    }
    // Precedence (I-078): the spawn request / agent definition → the sub-agent settings → the parent's.
    const harness = this.records.requireHarness(caller);
    const settingsModels = ctx.store.getSettings().models;
    const model = req.model
      ? await this.resolveModel(harness, req.model)
      : ((await this.availableModel(harness, settingsModels.subagentModel)) ?? caller.model);
    if (req.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(req.thinking)) {
      throw new HttpError(400, `thinking must be one of ${THINKING_LEVELS.join(", ")}`);
    }
    const thinkingLevel = (req.thinking as ThinkingLevel | undefined) ?? settingsModels.subagentThinkingLevel ?? caller.thinkingLevel;

    // No awaits from here until the record is registered, so parallel spawns can't overshoot.
    if (ctx.agents.findActive(caller.id, name)) throw new HttpError(409, `An agent named "${name}" is already running. Pick another name.`);
    const active = ctx.agents.activeIn(caller.workspaceId);
    if (active.length >= MAX_ACTIVE_AGENTS) {
      throw new HttpError(429, `Limit reached: ${MAX_ACTIVE_AGENTS} active agents. Close one first (close_agent).`);
    }
    const identity = pickAgentIdentity(active);
    const agent = req.agent?.trim() || null;
    const tools = req.tools?.length ? [...new Set([...req.tools, "report_done", "message_agent"])] : null;
    const systemPrompt = buildRolePrompt({
      name,
      teammates: active.filter((r) => r.parentSessionId === caller.id).map((r) => r.name),
      agent,
      agentPrompt: req.agentPrompt,
    });
    let record: AgentRecord | undefined;
    const detail = await this.sessions.createSession(
      caller.workspaceId,
      { prompt: task, model, thinkingLevel },
      {
        kind: "subagent",
        parentSessionId: caller.id,
        agentName: name,
        identity,
        register: (session) => {
          record = ctx.agents.upsert({
            sessionId: session.id,
            parentSessionId: caller.id,
            workspaceId: caller.workspaceId,
            name,
            displayName: identity.displayName,
            color: identity.color,
            agent,
            task,
            systemPrompt,
            tools,
            autoClose: !req.keepOpen,
            keepOpenReason: req.keepOpen ? keepOpenReason : null,
            userEngaged: false,
            spawnedAt: Date.now(),
            doneAt: null,
            result: null,
            closing: false,
            closed: false,
          });
          this.records.pushSessions([caller.id]); // its spawnedAgents changed
        },
      },
    );
    return { agent: agentInfo(ctx.agents.get(detail.session.id) ?? record!, detail.session.running) };
  }

  /** `model` when the harness lists it, else `null` (a setting's model from another harness). */
  private async availableModel(harness: AgentHarness, model: ModelRef | null): Promise<ModelRef | null> {
    if (!model) return null;
    const models = await harness.listModels().catch(() => [] as ModelInfo[]);
    return models.some((m) => sameModel(m, model)) ? model : null;
  }

  /** `provider/id`, or a bare id matched against the harness's models. */
  private async resolveModel(harness: AgentHarness, value: string): Promise<ModelRef> {
    const slash = value.indexOf("/");
    if (slash > 0 && slash < value.length - 1) return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
    const models = await harness.listModels().catch(() => [] as ModelInfo[]);
    const match = models.find((m) => m.id === value);
    if (!match) throw new HttpError(400, `Unknown model "${value}"`);
    return { provider: match.provider, id: match.id };
  }

  /** Message the parent (`to: "main"`, sub-agents only) or an active sub-agent of the team. */
  messageAgent(callerId: string, req: MessageAgentRequest): void {
    const caller = this.records.requireSession(callerId);
    const self = this.ctx.agents.get(caller.id);
    const text = req.text?.trim();
    if (!text) throw new HttpError(400, "text is required");
    if (req.to === MAIN_AGENT) {
      if (!self) throw new HttpError(400, 'You are the main session; message a sub-agent by name');
      this.deliver(self.parentSessionId, messageText(self.name, req.text), "steer");
      return;
    }
    const target = this.ctx.agents.findActive(self ? self.parentSessionId : caller.id, normalizeAgentName(req.to ?? ""));
    if (!target || target.sessionId === caller.id) throw new HttpError(404, `No active agent named "${req.to}".`);
    this.deliver(target.sessionId, messageText(self?.name ?? MAIN_AGENT, req.text), "steer");
  }

  /** The caller's team: its sub-agents (main) or its teammates (sub-agent). */
  listAgents(callerId: string): ListAgentsResponse {
    const caller = this.records.requireSession(callerId);
    const self = this.ctx.agents.get(caller.id);
    const team = this.ctx.agents.childrenOf(self ? self.parentSessionId : caller.id);
    return {
      self: { sessionId: caller.id, role: self ? "subagent" : "main", name: self?.name ?? null },
      agents: team.map((r) => agentInfo(r, this.ctx.live.get(r.sessionId)?.running ?? null)),
    };
  }

  /**
   * Close one of the caller's sub-agents (its tab and conversation go away): now if it's idle,
   * else when its turn ends (30s at most). Closing an already closed agent is fine (idempotent).
   */
  async closeAgent(callerId: string, name: string): Promise<CloseAgentResponse> {
    const { ctx } = this;
    this.records.requireSession(callerId);
    const target = ctx.agents.findLatest(callerId, normalizeAgentName(name ?? ""));
    if (!target) throw new HttpError(404, `No agent named "${name}".`);
    if (target.removed || !ctx.store.getSession(target.sessionId)) {
      if (!target.removed) ctx.agents.update(target.sessionId, { closing: false, closed: true, removed: true });
      return { closed: true, alreadyClosed: true };
    }
    if (!ctx.live.get(target.sessionId)?.running) {
      await this.closeAgentSession(target.sessionId);
      return { closed: true };
    }
    if (!target.closing) this.records.updateAgent(target.sessionId, { closing: true });
    if (!ctx.agentTimers.has(target.sessionId) || !target.closing) {
      ctx.agentTimers.set(target.sessionId, CLOSE_GRACE_MS, () => void this.closeAgentSession(target.sessionId));
    }
    return { closed: false };
  }

  /** A sub-agent's result: delivered to its parent; the sub-agent stops after this turn unless kept open. */
  reportAgentDone(callerId: string, req: ReportDoneRequest): ReportDoneResponse {
    const { ctx } = this;
    this.records.requireSession(callerId);
    const self = ctx.agents.get(callerId);
    if (!self) throw new HttpError(403, "Only sub-agents can report_done");
    const summary = req.summary?.trim();
    if (!summary) throw new HttpError(400, "summary is required");
    const closing = self.autoClose && !req.keepOpen && !self.userEngaged;
    const record = this.records.updateAgent(callerId, { doneAt: Date.now(), result: summary, closing })!;
    this.deliver(self.parentSessionId, doneText(record, summary), "followUp");
    if (closing) {
      // Normally at the end of the current turn (run_end); right away if it isn't running.
      if (!ctx.live.get(callerId)?.running) void this.closeAgentSession(callerId);
    } else if (!self.userEngaged) {
      ctx.agentTimers.set(callerId, IDLE_CLOSE_MS, () => {
        const current = ctx.agents.get(callerId);
        if (current && !current.closed && !current.userEngaged && !ctx.live.get(callerId)?.running) void this.closeAgentSession(callerId);
      });
    }
    return { closing };
  }

  /**
   * Close a sub-agent for good (I-055): stop its process and delete its session, like closing a
   * cmux pane; its result has been delivered to the parent. The record stays (closed, removed)
   * so list_agents shows it and close_agent is idempotent.
   */
  async closeAgentSession(sessionId: string): Promise<void> {
    const { ctx } = this;
    ctx.agentTimers.clear(sessionId);
    const record = ctx.agents.get(sessionId);
    if (!record || record.removed) return;
    ctx.agents.update(sessionId, { closing: false, closed: true, removed: true });
    const session = ctx.store.getSession(sessionId);
    if (!session) return;
    await this.pool.disposeSession(session);
    ctx.tokens.revoke(sessionId);
    if (!ctx.store.getSession(sessionId)) return; // deleted meanwhile
    ctx.store.removeSession(sessionId);
    ctx.broadcast({ type: "session_removed", sessionId, workspaceId: session.workspaceId });
    this.records.refreshWorkspace(session.workspaceId);
  }

  /**
   * Send `text` to a session as a prompt (a follow-up or steer if it's running), in order per
   * target. Failures are logged; the caller's request has already succeeded.
   */
  deliver(targetId: string, text: string, behavior: "steer" | "followUp"): void {
    const { ctx } = this;
    const previous = ctx.deliveries.get(targetId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const giveUpAt = Date.now() + ELSEWHERE_RETRY_MS;
        for (;;) {
          if (!ctx.store.getSession(targetId) || ctx.disposed) return;
          try {
            const live = await this.pool.ensureLive(targetId);
            await this.actions.sendPrompt(targetId, { text, behavior }, live);
            return;
          } catch (err) {
            // The target runs in another server on this data folder (I-062): wait until it's free.
            if (!(err instanceof ActiveElsewhereError) || Date.now() > giveUpAt) throw err;
            await new Promise((r) => setTimeout(r, 2000).unref());
          }
        }
      })
      .catch((err: Error) => ctx.options.log?.(`agent-teams: delivery to ${targetId} failed: ${err.message}`));
    ctx.deliveries.set(targetId, next);
    void next.finally(() => {
      if (ctx.deliveries.get(targetId) === next) ctx.deliveries.delete(targetId);
    });
  }

  /** Wait for queued deliveries (tests). */
  async settleAgentDeliveries(): Promise<void> {
    while (this.ctx.deliveries.size) await Promise.all([...this.ctx.deliveries.values()]);
  }
}
