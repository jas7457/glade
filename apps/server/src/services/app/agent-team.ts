/**
 * The agent API (I-037): sub-agents as `subagent` sessions (see http/agents.ts). Spawning,
 * messaging, listing, closing and `report_done`, plus the per-target delivery queue that turns
 * agent messages into prompts (retried while the target runs in another server, I-062).
 */
import {
  INHERIT,
  MAX_ACTIVE_AGENTS,
  THINKING_LEVELS,
  agentLabel,
  agentModelSettings,
  clampThinkingLevel,
  sameModel,
  type AgentDef,
  type AgentDefFields,
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
import { GLADE_MCP_SERVER } from "../../harness/claude/glade-tools.js";
import { GLADE_TOOL_NAMES } from "../../harness/pi/extension/glade-tools.js";
import type { AgentHarness, SessionAgentDefinition, SpawnableAgent, SpawnableAgentList } from "../../harness/types.js";
import type { AgentDefsListContext, AgentDefsScope, ResolvedAgentDef } from "../agent-defs/service.js";
import { agentDefsListContext } from "../agent-defs/switches.js";
import { pickAgentIdentity } from "../agent-names.js";
import {
  CLOSE_GRACE_MS,
  IDLE_CLOSE_MS,
  MAIN_AGENT,
  REPORT_REMINDER,
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
import type { Titles } from "./titles.js";

/** Deliveries to a session busy in another server are retried this long. */
const ELSEWHERE_RETRY_MS = 30 * 60_000;

/**
 * Harnesses that silently ignore tool names they don't have (pi's `--tools`): a definition's tools
 * are checked against the last reported list before spawning (I-218).
 */
const STRICT_TOOL_HARNESSES = new Set(["pi"]);

export class AgentTeam {
  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
    private readonly pool: LivePool,
    private readonly actions: SessionActions,
    private readonly sessions: Sessions,
    private readonly titles: Titles,
  ) {}

  /** The session a token belongs to (401 for unknown, revoked or stale tokens). */
  authenticateAgent(token: string | undefined): Session {
    const sessionId = token ? this.ctx.tokens.sessionFor(token) : undefined;
    const session = sessionId ? this.ctx.store.getSession(sessionId) : undefined;
    if (!session) throw new HttpError(401, "Invalid agent token");
    return session;
  }

  /**
   * Start a sub-agent in the caller's workspace (same folder); its first prompt is the task. Its
   * agent definition (`req.agent`, I-218) is resolved here; it runs on the requested harness, else
   * the definition's, else the parent's (I-217).
   */
  async spawnAgent(callerId: string, req: SpawnAgentRequest): Promise<SpawnAgentResponse> {
    const { ctx } = this;
    const caller = this.records.requireSession(callerId);
    if (caller.kind !== "main") throw new HttpError(403, "Sub-agents can't spawn agents");
    const settings = ctx.store.getSettings();
    if (!settings.agent.subagents) {
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
    if (req.thinking !== undefined && req.thinking !== INHERIT && !(THINKING_LEVELS as readonly string[]).includes(req.thinking)) {
      throw new HttpError(400, `thinking must be one of ${THINKING_LEVELS.join(", ")}`);
    }
    const workspace = this.records.requireWorkspace(caller.workspaceId);
    const scope = { projectId: workspace.projectId, cwd: workspace.cwd };
    const parentHarness = this.records.requireHarness(caller);

    // I-218: the agent definition, resolved by the server. Older agent-teams versions send the
    // definition's prompt/model/tools themselves (`agentPrompt`, …): used when the name doesn't resolve.
    const requested = req.agent?.trim() || null;
    const resolved = requested ? await this.resolveDefinition(requested, scope, req) : null;
    const def = resolved?.def.effective ?? null;
    const agent = resolved ? def!.name || requested : requested;

    // I-217: the child's harness: the request's → the definition's → the parent's.
    const harness = this.childHarness([req.harness, def?.harness].find((h) => h && h !== INHERIT) ?? parentHarness.id, agent);
    const sameHarness = harness.id === parentHarness.id;
    if (!sameHarness && harness.info.capabilities.subagents === false) {
      throw new HttpError(400, `${harness.info.label} can't run Glade sub-agents (it has no report_done/message_agent tools). Pick another harness.`);
    }

    // Model and thinking within that harness (I-078, I-198, I-217): the request's / definition's when
    // the harness lists it → its sub-agent settings → the parent's (same harness only) → its defaults.
    const { model, thinkingLevel } = await this.childModel(harness, caller, sameHarness, {
      model: req.model ?? (def && def.model !== INHERIT ? def.model : undefined),
      thinking: (req.thinking !== INHERIT ? req.thinking : undefined) ?? (def && def.thinking !== INHERIT ? def.thinking : undefined),
    });

    // Tools: the definition's (or the legacy request's), checked where the harness ignores unknown names.
    const listed = resolved ? def!.tools : req.tools?.length ? req.tools : null;
    if (listed?.length) this.checkTools(harness, scope.projectId, agent ?? name, listed);
    const tools = listed?.length ? [...new Set([...listed, "report_done", "message_agent"])] : null;

    // No awaits from here until the record is registered, so parallel spawns can't overshoot.
    if (ctx.agents.findActive(caller.id, name)) throw new HttpError(409, `An agent named "${name}" is already running. Pick another name.`);
    const active = ctx.agents.activeIn(caller.workspaceId);
    // The harness's own sub-agents (I-188) don't count: Glade doesn't run them.
    if (active.filter((r) => !r.native).length >= MAX_ACTIVE_AGENTS) {
      throw new HttpError(429, `Limit reached: ${MAX_ACTIVE_AGENTS} active agents. Close one first (close_agent).`);
    }
    // I-144: avoid names this chat's sub-agents (closed ones too) have already had. I-218: the
    // definition's nicknames, colour and icon.
    const identity = pickAgentIdentity(
      active,
      ctx.agents.childrenOf(caller.id).map((r) => r.displayName),
      Math.random,
      def ? { nicknames: def.nicknames, color: def.color, icon: def.icon } : {},
    );
    const roleOptions = {
      name,
      displayName: identity.displayName,
      teammates: active.filter((r) => r.parentSessionId === caller.id && !r.native).map((r) => agentLabel(r.name, r.displayName)),
      agent,
    };
    const systemPrompt = buildRolePrompt({ ...roleOptions, agentPrompt: resolved ? def!.prompt : req.agentPrompt });
    const definition: SessionAgentDefinition | undefined = resolved
      ? {
          name: agent!,
          description: def!.description,
          prompt: def!.prompt,
          rolePrompt: buildRolePrompt(roleOptions),
          tools: def!.tools,
          disallowedTools: def!.disallowedTools,
          permissionMode: def!.permissionMode,
          sandbox: def!.sandbox,
          native: resolved.native,
        }
      : undefined;
    let record: AgentRecord | undefined;
    const detail = await this.sessions.createSession(
      caller.workspaceId,
      { prompt: task, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) },
      {
        kind: "subagent",
        parentSessionId: caller.id,
        agentName: name,
        identity,
        harness: harness.id,
        register: (session) => {
          record = ctx.agents.upsert({
            sessionId: session.id,
            parentSessionId: caller.id,
            workspaceId: caller.workspaceId,
            name,
            displayName: identity.displayName,
            color: identity.color,
            ...(identity.icon ? { icon: identity.icon } : {}),
            harness: harness.id,
            agent,
            ...(definition ? { definition } : {}),
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
    // A short title for its tab and chip (I-148); failures only cost the title.
    void this.titles
      .generateAgentTitle(detail.session.id, task)
      .catch((err: Error) => ctx.options.log?.(`sub-agent title generation failed: ${err.message}`));
    return { agent: agentInfo(ctx.agents.get(detail.session.id) ?? record!, detail.session.running) };
  }

  /** What `list`/`resolve` need: the on/off switches and the harnesses offered here. */
  private defsContext(): AgentDefsListContext {
    return agentDefsListContext(this.ctx);
  }

  /**
   * The definition named `name` (I-218); `null` for an older agent-teams request that carries the
   * definition itself (it then works as before). Unknown/unavailable otherwise: 400 naming the
   * available ones.
   */
  private async resolveDefinition(name: string, scope: AgentDefsScope, req: SpawnAgentRequest): Promise<ResolvedAgentDef | null> {
    try {
      return await this.ctx.agentDefs.resolve(name, scope, this.defsContext());
    } catch (err) {
      if (req.agentPrompt?.trim() || req.tools?.length || req.model || req.thinking) return null;
      throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message);
    }
  }

  /** A registered harness this device offers (installed and on), else 400 for the orchestrator. */
  private childHarness(id: string, agent: string | null): AgentHarness {
    const { harnesses } = this.ctx;
    const offered = harnesses.offered().filter((h) => h.info.capabilities.subagents !== false);
    const others = offered.length ? ` Available: ${offered.map((h) => `${h.id} (${h.info.label})`).join(", ")}.` : "";
    const harness = harnesses.get(id);
    const what = agent ? `the agent "${agent}"` : "the sub-agent";
    if (!harness) throw new HttpError(400, `There's no agent harness "${id}" in Glade, so ${what} can't start.${others}`);
    if (!harnesses.isOffered(harness)) {
      throw new HttpError(400, `${harness.info.label} isn't available on ${this.ctx.deviceName()} (turned off or not installed), so ${what} can't start on it.${others}`);
    }
    return harness;
  }

  /**
   * The child's model and thinking level (see {@link spawnAgent}). `undefined` = leave it to the
   * new session's defaults (the harness's default model / thinking for new chats).
   */
  private async childModel(
    harness: AgentHarness,
    caller: Session,
    sameHarness: boolean,
    wanted: { model?: string; thinking?: string },
  ): Promise<{ model?: ModelRef; thinkingLevel?: ThinkingLevel }> {
    if (harness.info.capabilities.models === false) return {}; // ACP agents pick their own (I-119)
    const settingsModels = agentModelSettings(this.ctx.store.getSettings(), harness.id);
    const models = await harness.listModels().catch(() => [] as ModelInfo[]);
    let model: ModelRef | undefined;
    if (wanted.model) {
      const match = findModel(models, wanted.model);
      if (match) model = { provider: match.provider, id: match.id };
      else this.ctx.options.log?.(`sub-agent: ${harness.info.label} has no model "${wanted.model}"; using its sub-agent default`);
    }
    model ??= (settingsModels.subagentModel && models.some((m) => sameModel(m, settingsModels.subagentModel)) ? settingsModels.subagentModel : undefined) ?? undefined;
    if (!model && sameHarness && caller.model) model = caller.model;
    let thinkingLevel = (wanted.thinking as ThinkingLevel | undefined) ?? settingsModels.subagentThinkingLevel ?? (sameHarness ? (caller.thinkingLevel ?? undefined) : undefined);
    const info = model ? models.find((m) => sameModel(m, model)) : undefined;
    if (thinkingLevel && info?.thinkingLevels?.length) thinkingLevel = clampThinkingLevel(info.thinkingLevels, thinkingLevel);
    return { ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) };
  }

  /**
   * Refuse a tool list naming tools the harness doesn't have, on harnesses that silently ignore
   * unknown names (pi's `--tools`): checked against the tools a session last reported, when known.
   */
  private checkTools(harness: AgentHarness, projectId: string | null, agent: string, tools: readonly string[]): void {
    if (!STRICT_TOOL_HARNESSES.has(harness.id)) return;
    const seen = this.ctx.agentDefs.tools(harness.id, projectId);
    if (!seen.seenAt || !seen.tools.length) return;
    const known = new Set([...seen.tools, ...GLADE_TOOL_NAMES]);
    const missing = tools.filter((t) => !known.has(t));
    if (missing.length) {
      throw new HttpError(400, `Can't spawn "${agent}": ${harness.info.label} doesn't have the tools ${missing.join(", ")}. Install them (then start a new chat), or remove them from the agent.`);
    }
  }

  /** The agents a session's spawn_agent lists (I-218): enabled and available in its project. */
  async spawnableAgents(sessionId: string): Promise<SpawnableAgentList> {
    const { ctx } = this;
    const session = this.records.requireSession(sessionId);
    const workspace = this.records.requireWorkspace(session.workspaceId);
    const label = (id: string) => ctx.harnesses.get(id)?.info.label ?? id;
    const defs = await ctx.agentDefs.list({ projectId: workspace.projectId, cwd: workspace.cwd }, this.defsContext()).catch((err: Error) => {
      ctx.options.log?.(`agent definitions: listing failed: ${err.message}`);
      return [] as AgentDef[];
    });
    const agents = defs.filter((d) => d.enabled && d.available && !d.customizedBy).map((d) => spawnableAgent(d.effective, label));
    const harnesses = ctx.harnesses
      .offered()
      .filter((h) => h.info.capabilities.subagents !== false || h.id === session.harness)
      .map((h) => ({ id: h.id, label: h.info.label }));
    return { agents, harnesses };
  }

  /** A session's harness reported its tools (I-218); Glade's own are left out. */
  recordTools(sessionId: string, harnessId: string, tools: readonly string[], mcpServers: readonly string[] = []): void {
    const session = this.records.requireSession(sessionId);
    const projectId = this.ctx.store.getWorkspace(session.workspaceId)?.projectId ?? null;
    const glade = new Set(GLADE_TOOL_NAMES);
    const own = (t: string) => glade.has(t) || t.startsWith(`mcp__${GLADE_MCP_SERVER}__`);
    const names = [...new Set(tools.filter((t) => typeof t === "string" && t && !own(t)))];
    const servers = [...new Set(mcpServers.filter((s) => typeof s === "string" && s && s !== GLADE_MCP_SERVER))];
    this.ctx.agentDefs.recordTools(harnessId, projectId, names, servers);
  }

  /** Message the parent (`to: "main"`, sub-agents only) or an active sub-agent of the team. */
  messageAgent(callerId: string, req: MessageAgentRequest): void {
    const caller = this.records.requireSession(callerId);
    const self = this.ctx.agents.get(caller.id);
    const text = req.text?.trim();
    if (!text) throw new HttpError(400, "text is required");
    if (req.to === MAIN_AGENT) {
      if (!self) throw new HttpError(400, 'You are the main session; message a sub-agent by name');
      this.deliver(self.parentSessionId, messageText(self, req.text), "steer");
      return;
    }
    const target = this.ctx.agents.findActive(self ? self.parentSessionId : caller.id, normalizeAgentName(req.to ?? ""));
    if (!target || target.sessionId === caller.id) throw new HttpError(404, `No active agent named "${req.to}".`);
    // New work from its team: it may be reminded to report again.
    if (target.reminded) this.ctx.agents.update(target.sessionId, { reminded: false });
    this.deliver(target.sessionId, messageText(self ?? MAIN_AGENT, req.text), "steer");
  }

  /** The caller's team: its sub-agents (main) or its teammates (sub-agent). */
  listAgents(callerId: string): ListAgentsResponse {
    const caller = this.records.requireSession(callerId);
    const self = this.ctx.agents.get(caller.id);
    // Native sub-agents (I-188) aren't part of the team: they can't be messaged or closed.
    const team = this.ctx.agents.childrenOf(self ? self.parentSessionId : caller.id).filter((r) => !r.native);
    return {
      self: { sessionId: caller.id, role: self ? "subagent" : "main", name: self?.name ?? null },
      agents: team.map((r) => agentInfo(r, this.ctx.live.get(r.sessionId)?.running ?? null)),
    };
  }

  /**
   * A sub-agent's turn ended without report_done (and it isn't closing): remind it once, so a
   * finished agent reports and a stuck one asks. Not when the user typed in it, the turn was
   * stopped or failed, a message for it is already on its way, or it was reminded already.
   */
  agentTurnEnded(sessionId: string, clean: boolean): void {
    const { ctx } = this;
    const record = ctx.agents.get(sessionId);
    if (!record || record.native || record.closed || record.closing || record.doneAt !== null || record.userEngaged || record.reminded) return;
    if (!clean || ctx.deliveries.has(sessionId)) return;
    ctx.agents.update(sessionId, { reminded: true });
    this.deliver(sessionId, REPORT_REMINDER, "followUp");
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

/** `provider/id` (first slash) or a bare id, matched against a harness's models. */
export function findModel(models: readonly ModelInfo[], value: string): ModelInfo | undefined {
  const slash = value.indexOf("/");
  if (slash > 0 && slash < value.length - 1) {
    const ref = { provider: value.slice(0, slash), id: value.slice(slash + 1) };
    const exact = models.find((m) => sameModel(m, ref));
    if (exact) return exact;
  }
  return models.find((m) => m.id === value);
}

/** Tools that change files or run commands, per harness's naming (pi, Claude Code). */
const WRITE_TOOLS = new Set(["write", "edit", "bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);

/**
 * Whether an agent can't change anything (the "read-only" hint in spawn_agent's list): Codex's
 * read-only sandbox, Claude Code's plan mode or a tool list without writing tools (also through
 * `disallowedTools`), pi's tool list without write/edit/bash.
 */
export function isReadOnlyAgent(def: Pick<AgentDefFields, "harness" | "tools" | "disallowedTools" | "permissionMode" | "sandbox">): boolean {
  if (def.sandbox) return def.sandbox === "read-only";
  if (def.permissionMode === "plan") return true;
  if (def.tools?.length) return !def.tools.some((t) => WRITE_TOOLS.has(t));
  const denied = new Set(def.disallowedTools ?? []);
  return ["Write", "Edit", "Bash"].every((t) => denied.has(t));
}

/** A definition as spawn_agent lists it: `- scout (Claude Code · haiku, read-only): …`. */
export function spawnableAgent(def: AgentDefFields, label: (harnessId: string) => string): SpawnableAgent {
  const harness = def.harness && def.harness !== INHERIT ? def.harness : null;
  const model = def.model && def.model !== INHERIT ? def.model.slice(def.model.indexOf("/") + 1) : null;
  return { name: def.name, description: def.description, harness, harnessLabel: harness ? label(harness) : null, model, readOnly: isReadOnlyAgent(def) };
}
