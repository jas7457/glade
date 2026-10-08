/**
 * Demo harnesses (I-209): stand-ins for pi, Claude Code and Codex that play back the scripted
 * conversations in `scenarios.ts`, for the website's screenshots and videos. Only registered in
 * demo sandboxes (`GLADE_HARNESS=demo` + `GLADE_SANDBOX`, see `config.ts` `harnessMode`).
 *
 * A prompt that matches a scenario plays it (player.ts compiles it into timed events): thinking,
 * text streamed at a realistic pace, tool calls one by one, edits written to the chat's folder
 * (the sandbox's demo repo, so the changes panel and worktrees are real), sub-agents spawned
 * through Glade's agent API (each plays its own script and reports with report_done). When every
 * sub-agent of a turn has reported, the parent plays the scenario's closing summary. Prompts run
 * one after another, like a real agent's queue.
 */
import {
  applyAgentEvent,
  AGENT_ENV,
  clampThinkingLevel,
  defaultSessionState,
  emptyTranscript,
  parseAgentMessage,
  type AgentEvent,
  type CompactResult,
  type FolderPermissionModes,
  type HarnessDefaults,
  type ModelInfo,
  type ModelRef,
  type PromptRequest,
  type SessionState,
  type SlashCommand,
  type ThinkingLevel,
  type Transcript,
  type UiResponse,
  type UsageLimits,
} from "@glade/protocol";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { compactionNoticeText } from "../format.js";
import { SessionEvents } from "../session-events.js";
import type { AgentHarness, GenerateTitleOptions, HarnessDescription, HarnessSession, OpenSessionOptions, SideQuestionCall, SideQuestionResult } from "../types.js";
import type { DemoAgent } from "./agents.js";
import { compileTurn, INSTANT_PACE, LIVE_PACE, type DemoAction, type DemoPace, type DemoStep } from "./player.js";
import { DEMO_SUBAGENTS, fallbackSteps, findScenario, subagentForTask, toolsFor, type DemoScenario } from "./scenarios.js";

/** History is played fast but not instantly, so tool durations and order still look real. */
export const HISTORY_PACE: DemoPace = { ...LIVE_PACE, scale: 0.04 };

export interface DemoHarnessOptions {
  /** Pace overrides (tests). */
  livePace?: DemoPace;
  historyPace?: DemoPace;
  log?: (msg: string) => void;
}

interface StoredSession {
  transcript: Transcript;
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  permissionMode: string | null;
  contextTokens: number;
  totalTokens: number;
  cost: number;
}

const RUN_ID = Date.now().toString(36);
let instances = 0;

export class DemoHarness implements AgentHarness {
  readonly id: string;
  readonly info: HarnessDescription;
  readonly sessions = new Map<string, StoredSession>();
  private counter = 0;

  constructor(
    readonly agent: DemoAgent,
    readonly options: DemoHarnessOptions = {},
  ) {
    this.id = agent.id;
    this.info = { label: agent.label, capabilities: { ...agent.capabilities } };
  }

  isInstalled(): boolean {
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.agent.models;
  }

  async getDefaults(): Promise<HarnessDefaults> {
    const m = this.agent.models[this.agent.defaultModel]!;
    return { model: { provider: m.provider, id: m.id }, thinkingLevel: this.agent.defaultThinking };
  }

  async listFolderCommands(): Promise<SlashCommand[]> {
    return this.agent.commands;
  }

  async getPermissionModes(): Promise<FolderPermissionModes> {
    return { modes: this.agent.permissionModes, defaultMode: this.agent.defaultPermissionMode };
  }

  async getUsageLimits(): Promise<UsageLimits | null> {
    return this.agent.usage(Date.now());
  }

  async openSession(options: OpenSessionOptions): Promise<HarnessSession> {
    let ref = options.sessionRef;
    if (!ref || !this.sessions.has(ref)) {
      ref = ref ?? `demo-${this.id}-${++this.counter}-${RUN_ID}`;
      const defaults = await this.getDefaults();
      const modes = this.agent.permissionModes;
      this.sessions.set(ref, {
        transcript: emptyTranscript(),
        model: options.model ?? defaults.model,
        thinkingLevel: options.thinkingLevel ?? defaults.thinkingLevel ?? "medium",
        permissionMode: modes.some((m) => m.id === options.permissionMode) ? options.permissionMode! : this.agent.defaultPermissionMode,
        contextTokens: 21_400,
        totalTokens: 0,
        cost: 0,
      });
    }
    return new DemoSession(this, ref, options.cwd, options.env ?? {});
  }

  async deleteSession(sessionRef: string): Promise<void> {
    this.sessions.delete(sessionRef);
  }

  async readTranscript(sessionRef: string): Promise<Transcript | null> {
    return this.sessions.get(sessionRef)?.transcript ?? null;
  }

  async generateTitle({ firstMessage }: GenerateTitleOptions): Promise<string | null> {
    const sub = subagentForTask(firstMessage);
    if (sub) return sub.title;
    const scenario = findScenario(firstMessage, this.agent.id);
    if (scenario) return scenario.title;
    const words = firstMessage.replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
    return words.length > 48 ? `${words.slice(0, 47)}…` : words;
  }

  async answerSideQuestion(call: SideQuestionCall): Promise<SideQuestionResult> {
    const answer =
      "Short version: yes. The retry loop only records the **last** attempt, so the dashboard and the uptime numbers never see the failed tries; only the final result counts. If you want to see flakiness, the cheapest option is a `retries_used` column next to `latency_ms`.";
    let sent = "";
    for (const word of answer.split(/(?<= )/)) {
      await sleep(18);
      if (call.signal.aborted) return { answer: sent };
      sent += word;
      call.onDelta(word);
    }
    return { answer };
  }

  async dispose(): Promise<void> {}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface PendingTeam {
  names: Set<string>;
  scenario: DemoScenario;
}

export class DemoSession implements HarnessSession {
  private readonly events = new SessionEvents();
  private state: SessionState;
  private idCounter = 0;
  private queue: Promise<void> = Promise.resolve();
  private aborted = false;
  private running = false;
  /** Sub-agents this session's last spawning turn waits for. */
  private team: PendingTeam | null = null;

  constructor(
    private readonly harness: DemoHarness,
    readonly sessionRef: string,
    readonly cwd: string,
    private readonly env: Record<string, string>,
  ) {
    const stored = this.stored;
    const info = this.modelInfo(stored.model);
    const modes = harness.agent.permissionModes;
    this.state = {
      ...defaultSessionState(),
      model: stored.model,
      thinkingLevel: stored.thinkingLevel,
      thinkingLevels: info?.thinkingLevels ?? ["off"],
      ...(modes.length ? { permissionMode: stored.permissionMode, permissionModes: modes } : {}),
      ...this.statsState(),
    };
  }

  private get stored(): StoredSession {
    return this.harness.sessions.get(this.sessionRef)!;
  }

  private modelInfo(model: ModelRef | null): ModelInfo | undefined {
    return this.harness.agent.models.find((m) => m.provider === model?.provider && m.id === model?.id);
  }

  private statsState(): Pick<SessionState, "contextUsage" | "sessionStats"> {
    const stored = this.stored;
    const contextWindow = this.modelInfo(stored.model)?.contextWindow ?? 200_000;
    const tokens = Math.min(stored.contextTokens, contextWindow);
    return {
      contextUsage: { tokens, contextWindow, percent: (tokens / contextWindow) * 100 },
      sessionStats: {
        tokens: { input: Math.round(stored.totalTokens * 0.3), output: Math.round(stored.totalTokens * 0.08), cacheRead: Math.round(stored.totalTokens * 0.6), cacheWrite: Math.round(stored.totalTokens * 0.02), total: stored.totalTokens },
        cost: stored.cost,
      },
    };
  }

  getState(): SessionState {
    return this.state;
  }

  async loadTranscript(): Promise<Transcript> {
    return this.stored.transcript;
  }

  async prompt(request: PromptRequest): Promise<void> {
    // Like a real agent: one turn at a time; steering and follow-ups wait for the current one.
    this.queue = this.queue.then(() => this.turn(request)).catch((err: Error) => this.harness.options.log?.(`[demo] turn failed: ${err.stack ?? err.message}`));
  }

  /** Ids stay unique when the chat's session is reopened (tool results are keyed by call id). */
  private readonly tag = (++instances).toString(36) + Date.now().toString(36);
  private nextId = () => `${this.sessionRef}-${this.tag}-${this.idCounter++}`;

  private async turn(request: PromptRequest): Promise<void> {
    const t = toolsFor(this.harness.agent);
    const agentName = this.env[AGENT_ENV.agentName];
    const report = parseAgentMessage(request.text);
    let steps: DemoStep[];
    let pace: DemoPace;
    let scenario: DemoScenario | null = null;
    let minMs = 0;
    if (report) {
      // A sub-agent reported (`[agent-teams] … finished:`): close the turn when the last one has.
      const team = this.team;
      team?.names.delete(report.from);
      if (team && team.names.size === 0 && team.scenario.afterReports) {
        this.team = null;
        steps = team.scenario.afterReports(t);
        pace = this.paceOf(team.scenario.pace);
      } else {
        steps = [];
        pace = INSTANT_PACE;
      }
    } else if (agentName) {
      const script = DEMO_SUBAGENTS.find((s) => s.name === agentName);
      steps = script ? script.steps(t) : [...fallbackSteps(request.text, t), { report: "Looked at the project layout; nothing to change for this task." }];
      minMs = script?.minMs ?? 0;
      pace = this.paceOf(script?.pace ?? "live");
    } else {
      scenario = findScenario(request.text, this.harness.agent.id);
      steps = scenario ? scenario.steps(t) : fallbackSteps(request.text, t);
      pace = this.paceOf(scenario?.pace ?? "live");
    }
    const spawned = steps.flatMap((s) => ("spawn" in s ? s.spawn.map((a) => a.name) : []));
    if (scenario && spawned.length) this.team = { names: new Set(spawned), scenario };

    const actions = compileTurn(steps, { nextId: this.nextId, files: { read: (p) => this.readFile(p) }, pace, model: this.stored.model });
    const stored = this.stored;
    const chars = steps.reduce((n, s) => n + ("say" in s ? s.say.length : "think" in s ? s.think.length : 400), 0);
    stored.contextTokens += 6_500 + Math.round(chars * 1.5);
    stored.totalTokens += 6_000 + chars;
    stored.cost += 0.012 + chars / 400_000;

    this.aborted = false;
    this.running = true;
    this.emit({ type: "run_start" });
    this.emit({ type: "state", state: { isRunning: true } });
    const user = { id: this.nextId(), role: "user" as const, content: [...(request.images ?? []).map((i) => ({ type: "image" as const, mimeType: i.mimeType, data: i.data })), { type: "text" as const, text: request.text }], timestamp: 0 };
    this.emit(this.stamp({ type: "message_start", message: user }));
    this.emit(this.stamp({ type: "message_end", message: user }));
    await this.play(actions, Date.now() + minMs);
    this.running = false;
    this.emit({ type: "state", state: { isRunning: false, ...this.statsState() } });
    this.emit({ type: "run_end" });
  }

  private paceOf(kind: "history" | "live"): DemoPace {
    return kind === "history" ? (this.harness.options.historyPace ?? HISTORY_PACE) : (this.harness.options.livePace ?? LIVE_PACE);
  }

  /** `reportAt`: a sub-agent doesn't report before then (its "Done · 41s" reads true even when seeded fast). */
  private async play(actions: DemoAction[], reportAt = 0): Promise<void> {
    let sinceYield = 0;
    for (const action of actions) {
      if (this.aborted) return;
      switch (action.type) {
        case "wait":
          sinceYield = 0;
          await sleep(action.ms);
          break;
        case "emit": {
          const event = this.stamp(action.event);
          this.emit(event);
          // Let the server breathe between bursts of instant events.
          if (++sinceYield >= 40) {
            sinceYield = 0;
            await new Promise((r) => setImmediate(r));
          }
          break;
        }
        case "write":
          this.writeFile(action.path, action.content);
          break;
        case "spawn":
          await this.agentApi("spawn", { name: action.name, task: action.task });
          break;
        case "report":
          if (Date.now() < reportAt) await sleep(reportAt - Date.now());
          await this.agentApi("report-done", { summary: action.summary });
          break;
      }
    }
  }

  private resolvePath(path: string): string | null {
    const abs = resolve(this.cwd, path);
    const rel = relative(this.cwd, abs);
    // Only ever inside the chat's folder (the sandbox's demo repo or its worktree).
    if (!this.cwd || !rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    return abs;
  }

  private readFile(path: string): string | null {
    const abs = this.resolvePath(path);
    if (!abs) return null;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  }

  private writeFile(path: string, content: string): void {
    const abs = this.resolvePath(path);
    if (!abs) return;
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    } catch (err) {
      this.harness.options.log?.(`[demo] could not write ${join(this.cwd, path)}: ${(err as Error).message}`);
    }
  }

  private async agentApi(path: string, body: unknown): Promise<void> {
    const url = this.env[AGENT_ENV.url];
    const token = this.env[AGENT_ENV.token];
    if (!url || !token) return;
    try {
      const res = await fetch(`${url}/api/agents/${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) this.harness.options.log?.(`[demo] agent API ${path}: ${res.status} ${await res.text()}`);
    } catch (err) {
      this.harness.options.log?.(`[demo] agent API ${path}: ${(err as Error).message}`);
    }
  }

  /** Messages get the time they started playing. */
  private readonly startedAt = new Map<string, number>();
  /** Every message gets its own millisecond: bookmarks and search jumps find messages by role + time. */
  private lastStamp = 0;
  private stamp(event: AgentEvent): AgentEvent {
    if (event.type !== "message_start" && event.type !== "message_end") return event;
    let at = this.startedAt.get(event.message.id);
    if (at === undefined) at = this.lastStamp = Math.max(Date.now(), this.lastStamp + 1);
    if (event.type === "message_start") this.startedAt.set(event.message.id, at);
    else this.startedAt.delete(event.message.id);
    return { ...event, message: { ...event.message, timestamp: at } };
  }

  emit(event: AgentEvent): void {
    if (event.type === "state") this.state = { ...this.state, ...event.state };
    this.stored.transcript = applyAgentEvent(this.stored.transcript, event);
    this.events.emit(event);
  }

  async abort(): Promise<void> {
    if (!this.running) return;
    this.aborted = true;
    this.running = false;
    this.team = null;
    this.emit({ type: "state", state: { isRunning: false } });
    this.emit({ type: "run_end" });
  }

  async setModel(model: ModelRef): Promise<void> {
    const info = this.modelInfo(model);
    if (!info) throw new Error(`Unknown model ${model.provider}/${model.id}`);
    this.stored.model = model;
    const thinkingLevel = clampThinkingLevel(info.thinkingLevels, this.state.thinkingLevel);
    this.emit({ type: "state", state: { model, thinkingLevels: info.thinkingLevels, thinkingLevel, ...this.statsState() } });
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const clamped = clampThinkingLevel(this.state.thinkingLevels, level);
    this.stored.thinkingLevel = clamped;
    this.emit({ type: "state", state: { thinkingLevel: clamped } });
  }

  async setPermissionMode(mode: string): Promise<void> {
    if (!this.harness.agent.permissionModes.some((m) => m.id === mode)) throw new Error(`Unknown mode ${mode}`);
    this.stored.permissionMode = mode;
    this.emit({ type: "state", state: { permissionMode: mode } });
  }

  async setTitle(): Promise<void> {}

  respondToUi(_response: UiResponse): void {}

  async listCommands(): Promise<SlashCommand[]> {
    return this.harness.agent.commands;
  }

  async compact(): Promise<CompactResult> {
    const stored = this.stored;
    const tokensBefore = stored.contextTokens;
    const tokensAfter = Math.round(tokensBefore / 5);
    this.emit({ type: "state", state: { isCompacting: true } });
    await sleep(1200);
    stored.contextTokens = tokensAfter;
    this.emit({ type: "state", state: { isCompacting: false, ...this.statsState() } });
    this.emit({ type: "message_end", message: { id: this.nextId(), role: "notice", kind: "compaction", text: compactionNoticeText(tokensBefore, tokensAfter), timestamp: Date.now() } });
    return { tokensBefore, tokensAfter };
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    return this.events.onEvent(listener);
  }

  onExit(listener: (error: Error | null) => void): () => void {
    return this.events.onExit(listener);
  }

  async dispose(): Promise<void> {
    this.aborted = true;
  }
}

