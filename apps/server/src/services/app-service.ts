import { mkdirSync } from "node:fs";
import type {
  AttachmentUploadResponse,
  CloseAgentResponse,
  CompactResult,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  DeepPartial,
  EnvironmentInfo,
  GenerateTitleResponse,
  HarnessInfo,
  ListAgentsResponse,
  MessageAgentRequest,
  ModelInfo,
  ModelRef,
  Project,
  ProjectGitInfo,
  PromptRequest,
  ReportDoneRequest,
  ReportDoneResponse,
  Session,
  SessionDetail,
  SessionSummary,
  Settings,
  ShellSnapshot,
  TranscriptPage,
  ShellRequest,
  ShellResponse,
  SlashCommand,
  SpawnAgentRequest,
  SpawnAgentResponse,
  ThinkingLevel,
  UiResponse,
  UpdateProjectRequest,
  UpdateSessionRequest,
  UpdateWorkspaceRequest,
  UsageLimits,
  WorkspaceDetail,
  WorkspaceSummary,
  WorktreeRemoval,
  WorktreeStatus,
} from "@glade/protocol";
import type { SessionText } from "../harness/types.js";
import { AgentTeam } from "./app/agent-team.js";
import { createAppContext, type AppContext, type AppServiceOptions, type Listener } from "./app/context.js";
import { LeaseSync } from "./app/lease-sync.js";
import { LivePool } from "./app/live-pool.js";
import { Projects } from "./app/projects.js";
import { sanitizeSettingsPatch } from "./app/prompts.js";
import { Records } from "./app/records.js";
import { SessionActions } from "./app/session-actions.js";
import { Transcripts, type ImportSummary } from "./app/transcripts.js";
import { Sessions, type NewSessionKind } from "./app/sessions.js";
import { DEFAULT_SMALL_MODEL, Titles } from "./app/titles.js";
import { Workspaces } from "./app/workspaces.js";
import type { AttachmentStore } from "./attachments.js";
import { LeaseManager } from "./leases.js";
import { UsageLimitsPoller } from "./usage-limits.js";
import { SyncHub, type SyncOptions } from "./sync/hub.js";
import { Environment, type EnvironmentOptions } from "./environment.js";

export { ActiveElsewhereError, HttpError } from "./app/errors.js";
export { decodedBase64Size } from "./app/session-actions.js";
export { DEFAULT_SMALL_MODEL } from "./app/titles.js";
export type { AppServiceOptions } from "./app/context.js";
export type { NewSessionKind } from "./app/sessions.js";

/**
 * Owns projects, workspaces, their sessions and the pool of live agent processes (one per
 * session). HTTP routes and the WebSocket are thin layers over this class, which keeps it easy
 * to test with the fake harness.
 *
 * A facade (I-094): the work is done by the modules in `./app/` (records, live pool, lease sync,
 * sessions, session actions, titles, workspaces, projects, agent team), which share one
 * `AppContext`. This class creates and wires them and keeps the public API in one place.
 */
export class AppService {
  /** Files attached by reference (I-090), per session; removed with the session. */
  readonly attachments: AttachmentStore;
  private readonly ctx: AppContext;
  private readonly records: Records;
  private readonly transcripts: Transcripts;
  private readonly pool: LivePool;
  private readonly leaseSync: LeaseSync;
  private readonly titles: Titles;
  private readonly actions: SessionActions;
  private readonly sessions: Sessions;
  private readonly workspaces: Workspaces;
  private readonly projects: Projects;
  private readonly team: AgentTeam;
  private readonly unwatch: Array<() => void> = [];
  /** Sequenced live sync to protocol-2 clients (I-122). */
  readonly sync: SyncHub;
  /** This server as an environment (I-123): id, name, capabilities. */
  readonly environment: Environment;

  constructor(options: AppServiceOptions & { sync?: SyncOptions; environment?: EnvironmentOptions }) {
    const ctx = createAppContext(options);
    this.ctx = ctx;
    this.environment = new Environment(ctx.store, options.environment);
    this.attachments = ctx.attachments;
    mkdirSync(options.scratchDir, { recursive: true });
    // Usage limits are the default harness's account (the gauge is app-wide).
    ctx.usage = ctx.harnesses.list().some((h) => h.getUsageLimits)
      ? new UsageLimitsPoller({
          fetchLimits: async () => {
            const harness = ctx.harnesses.default();
            return harness.getUsageLimits ? harness.getUsageLimits() : null;
          },
          broadcast: (m) => ctx.broadcast(m),
          log: options.log,
        })
      : null;
    ctx.usage?.start();
    ctx.leases = options.registry
      ? new LeaseManager(options.dataDir ?? options.store.dataDir, options.registry, {
          scanMs: options.leaseScanMs,
          onForeignChange: (ids) => this.records.pushSessions(ids),
          onTakeoverRequest: (id) => this.leaseSync.handleTakeoverRequest(id),
          onScan: () => this.leaseSync.checkOrphanedRuns(),
        })
      : null;

    // Modules, lowest layer first; calls up the layers go through hooks.
    this.records = new Records(ctx);
    this.transcripts = new Transcripts(ctx);
    this.pool = new LivePool(ctx, this.records, this.transcripts, {
      closeAgentSession: (id) => this.team.closeAgentSession(id),
      deliver: (targetId, text, behavior) => this.team.deliver(targetId, text, behavior),
    });
    this.leaseSync = new LeaseSync(ctx, this.records, this.pool);
    this.titles = new Titles(ctx, this.records, this.transcripts, { updateWorkspace: (id, req) => this.workspaces.updateWorkspace(id, req) });
    this.actions = new SessionActions(ctx, this.records, this.pool, this.leaseSync, this.titles);
    this.sessions = new Sessions(ctx, this.records, this.pool, this.leaseSync, this.actions, this.transcripts, {
      deliver: (targetId, text, behavior) => this.team.deliver(targetId, text, behavior),
    });
    this.workspaces = new Workspaces(ctx, this.records, this.pool, this.leaseSync, this.sessions);
    this.projects = new Projects(ctx, this.records, this.workspaces);
    this.team = new AgentTeam(ctx, this.records, this.pool, this.actions, this.sessions);

    if (ctx.leases) {
      this.unwatch.push(ctx.store.onExternalChange((change) => this.leaseSync.applyExternalChange(change)));
      this.unwatch.push(ctx.agents.onExternalChange((ids) => this.records.pushSessions(ids)));
      ctx.store.watch();
      ctx.leases.start();
    }
    this.leaseSync.recoverInterruptedRuns();

    this.sync = new SyncHub(
      {
        store: ctx.store,
        shellSnapshot: () => this.shellSnapshot(),
        environmentInfo: () => this.environment.info(),
        sessionSummary: (id) => {
          const session = ctx.store.getSession(id);
          return session ? this.records.summarizeSession(session) : null;
        },
        workspaceSummary: (id) => {
          const workspace = ctx.store.getWorkspace(id);
          return workspace ? this.records.summarizeWorkspace(workspace) : null;
        },
        activeSessionSummaries: () => this.sessions.listSessions().filter((s) => s.running || s.pendingInputs > 0 || s.activeElsewhere),
        prepareSession: (id) => this.sessions.prepareSync(id),
        subscribe: (listener) => this.subscribe(listener),
        log: options.log,
      },
      options.sync,
    );
  }

  /** Everything the shell scope shows (I-122 snapshots). */
  shellSnapshot(): ShellSnapshot {
    return {
      projects: this.projects.listProjects(),
      workspaces: this.workspaces.listWorkspaces(),
      sessions: this.sessions.listSessions(),
      settings: this.ctx.store.getSettings(),
      environment: this.environment.info(),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Environment (I-123)
  // -------------------------------------------------------------------------------------------

  getEnvironment(): EnvironmentInfo {
    return this.environment.info();
  }

  /** Rename this environment (empty = the machine name); every client is told. */
  renameEnvironment(name: string): EnvironmentInfo {
    const environment = this.environment.rename(name);
    this.ctx.broadcast({ type: "environment", environment });
    return environment;
  }

  /** The store (command receipts, I-122). */
  get store() {
    return this.ctx.store;
  }

  // -------------------------------------------------------------------------------------------
  // Push channel
  // -------------------------------------------------------------------------------------------

  subscribe(listener: Listener): () => void {
    const { listeners, usage } = this.ctx;
    listeners.add(listener);
    usage?.setClientCount(listeners.size);
    return () => {
      listeners.delete(listener);
      usage?.setClientCount(listeners.size);
    };
  }

  /** Latest subscription usage limits (possibly stale), or null if unavailable. */
  getUsageLimits(): UsageLimits | null {
    return this.ctx.usage?.current() ?? null;
  }

  /** Track which sessions are on screen, so finished runs there don't get marked unread. */
  setViewing(sessionId: string, viewing: boolean): void {
    const { viewers } = this.ctx;
    const count = (viewers.get(sessionId) ?? 0) + (viewing ? 1 : -1);
    if (count <= 0) viewers.delete(sessionId);
    else viewers.set(sessionId, count);
    if (viewing) {
      const session = this.ctx.store.getSession(sessionId);
      if (session?.unread) {
        const next: Session = { ...session, unread: false };
        delete next.markedUnread;
        this.records.saveSession(next);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Settings + models
  // -------------------------------------------------------------------------------------------

  getSettings(): Settings {
    return this.ctx.store.getSettings();
  }

  /** The stored settings overrides, as a JSON export (I-121). */
  exportSettings(): DeepPartial<Settings> {
    return this.ctx.store.getSettingsOverrides();
  }

  updateSettings(patch: DeepPartial<Settings>): Settings {
    const settings = this.ctx.store.updateSettings(sanitizeSettingsPatch(patch));
    this.ctx.broadcast({ type: "settings", settings });
    return settings;
  }

  /** The installed harnesses, the default first (`GET /api/harnesses`, I-065). */
  listHarnesses(): HarnessInfo[] {
    return this.ctx.harnesses.info();
  }

  /** The default harness's models (what the model settings and new chats offer). */
  async listModels(force = false): Promise<ModelInfo[]> {
    const models = await this.ctx.harnesses.default().listModels(force);
    // A forced refresh may have changed the list; let every client know.
    if (force) this.ctx.broadcast({ type: "models", models });
    return models;
  }

  /**
   * One-shot completion with the default harness's small model (I-097 commit messages): the
   * small-model setting, else Haiku when listed, else the harness default. `null` when unavailable.
   */
  async completeQuick(prompt: string, cwd: string): Promise<string | null> {
    const harness = this.ctx.harnesses.default();
    if (!harness.complete) return null;
    const configured = this.ctx.store.getSettings().models.smallModel;
    const models = configured ? [] : await harness.listModels().catch(() => [] as ModelInfo[]);
    const small = models.some((m) => m.provider === DEFAULT_SMALL_MODEL.provider && m.id === DEFAULT_SMALL_MODEL.id) ? DEFAULT_SMALL_MODEL : null;
    return harness.complete({ prompt, cwd, model: configured ?? small, timeoutMs: 60_000 });
  }

  // -------------------------------------------------------------------------------------------
  // Projects (app/projects.ts)
  // -------------------------------------------------------------------------------------------

  listProjects(): Project[] {
    return this.projects.listProjects();
  }

  createProject(req: CreateProjectRequest): Project {
    return this.projects.createProject(req);
  }

  updateProject(id: string, req: UpdateProjectRequest): Project {
    return this.projects.updateProject(id, req);
  }

  reorderProjects(ids: string[]): Project[] {
    return this.projects.reorderProjects(ids);
  }

  openProject(id: string, app: unknown): Promise<void> {
    return this.projects.openProject(id, app);
  }

  deleteProject(id: string): Promise<void> {
    return this.projects.deleteProject(id);
  }

  getProjectGit(id: string): Promise<ProjectGitInfo> {
    return this.projects.getProjectGit(id);
  }

  checkoutProjectBranch(id: string, branch: string): Promise<ProjectGitInfo> {
    return this.projects.checkoutProjectBranch(id, branch);
  }

  createProjectBranch(id: string, name: string, checkout: boolean): Promise<ProjectGitInfo> {
    return this.projects.createProjectBranch(id, name, checkout);
  }

  // -------------------------------------------------------------------------------------------
  // Workspaces (app/workspaces.ts)
  // -------------------------------------------------------------------------------------------

  listWorkspaces(): WorkspaceSummary[] {
    return this.workspaces.listWorkspaces();
  }

  getWorkspaceDetail(id: string): WorkspaceDetail {
    return this.workspaces.getWorkspaceDetail(id);
  }

  createWorkspace(req: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
    return this.workspaces.createWorkspace(req);
  }

  updateWorkspace(id: string, req: UpdateWorkspaceRequest): Promise<WorkspaceSummary> {
    return this.workspaces.updateWorkspace(id, req);
  }

  reorderPinnedWorkspaces(projectId: string | null, ids: string[]): WorkspaceSummary[] {
    return this.workspaces.reorderPinnedWorkspaces(projectId, ids);
  }

  deleteWorkspace(id: string, worktree?: WorktreeRemoval): Promise<void> {
    return this.workspaces.deleteWorkspace(id, worktree);
  }

  getWorktreeStatus(id: string): Promise<WorktreeStatus> {
    return this.workspaces.getWorktreeStatus(id);
  }

  openWorkspace(id: string, app: unknown): Promise<void> {
    return this.workspaces.openWorkspace(id, app);
  }

  // -------------------------------------------------------------------------------------------
  // Sessions (app/sessions.ts) and what the user does in them (app/session-actions.ts)
  // -------------------------------------------------------------------------------------------

  listSessions(workspaceId?: string): SessionSummary[] {
    return this.sessions.listSessions(workspaceId);
  }

  readSessionText(sessionId: string): Promise<SessionText | null> {
    return this.sessions.readSessionText(sessionId);
  }

  requestOpenChat(sessionId: string): number {
    return this.sessions.requestOpenChat(sessionId);
  }

  createSession(workspaceId: string, req: CreateSessionRequest, how: NewSessionKind = { kind: "main" }): Promise<SessionDetail> {
    return this.sessions.createSession(workspaceId, req, how);
  }

  getSessionDetail(id: string): Promise<SessionDetail> {
    return this.sessions.getSessionDetail(id);
  }

  /** Earlier turns of a transcript (I-122 "load earlier"). */
  getTranscriptPage(id: string, before: number | undefined, turns: number): Promise<TranscriptPage> {
    return this.sessions.transcriptPage(id, before, turns);
  }

  updateSession(id: string, req: UpdateSessionRequest): Promise<SessionSummary> {
    return this.sessions.updateSession(id, req);
  }

  deleteSession(id: string): Promise<void> {
    return this.sessions.deleteSession(id);
  }

  saveAttachment(id: string, name: string, body: ReadableStream<Uint8Array> | null): Promise<AttachmentUploadResponse> {
    return this.actions.saveAttachment(id, name, body);
  }

  prompt(id: string, req: PromptRequest): Promise<void> {
    return this.actions.prompt(id, req);
  }

  generateSessionTitle(id: string): Promise<GenerateTitleResponse> {
    return this.titles.generateSessionTitle(id);
  }

  abort(id: string): Promise<void> {
    return this.actions.abort(id);
  }

  runShell(id: string, req: ShellRequest): Promise<ShellResponse> {
    return this.actions.runShell(id, req);
  }

  abortShell(id: string): Promise<void> {
    return this.actions.abortShell(id);
  }

  setModel(id: string, model: ModelRef): Promise<void> {
    return this.actions.setModel(id, model);
  }

  setThinkingLevel(id: string, level: ThinkingLevel): Promise<void> {
    return this.actions.setThinkingLevel(id, level);
  }

  listCommands(id: string): Promise<SlashCommand[]> {
    return this.actions.listCommands(id);
  }

  compact(id: string, instructions?: string): Promise<CompactResult> {
    return this.actions.compact(id, instructions);
  }

  exportSession(id: string, options: { reveal?: boolean } = {}): Promise<{ path: string }> {
    return this.actions.exportSession(id, options);
  }

  revealPath(path: string): Promise<void> {
    return this.actions.revealPath(path);
  }

  respondToUi(id: string, response: UiResponse): void {
    this.actions.respondToUi(id, response);
  }

  // -------------------------------------------------------------------------------------------
  // Agent API (I-037, app/agent-team.ts): sub-agents as `subagent` sessions; see http/agents.ts
  // -------------------------------------------------------------------------------------------

  /** This server's base URL for agents (`GLADE_URL`); set once listening. Applies to new processes. */
  setServerUrl(url: string): void {
    this.ctx.serverUrl = url.replace(/\/+$/, "");
  }

  authenticateAgent(token: string | undefined): Session {
    return this.team.authenticateAgent(token);
  }

  spawnAgent(callerId: string, req: SpawnAgentRequest): Promise<SpawnAgentResponse> {
    return this.team.spawnAgent(callerId, req);
  }

  messageAgent(callerId: string, req: MessageAgentRequest): void {
    this.team.messageAgent(callerId, req);
  }

  listAgents(callerId: string): ListAgentsResponse {
    return this.team.listAgents(callerId);
  }

  closeAgent(callerId: string, name: string): Promise<CloseAgentResponse> {
    return this.team.closeAgent(callerId, name);
  }

  reportAgentDone(callerId: string, req: ReportDoneRequest): ReportDoneResponse {
    return this.team.reportAgentDone(callerId, req);
  }

  /** Wait for queued deliveries (tests). */
  settleAgentDeliveries(): Promise<void> {
    return this.team.settleAgentDeliveries();
  }

  // -------------------------------------------------------------------------------------------
  // Live session pool (app/live-pool.ts) and lifecycle
  // -------------------------------------------------------------------------------------------

  /** Number of agent processes currently alive (for tests/diagnostics). */
  get liveCount(): number {
    return this.pool.liveCount;
  }

  /** Stop a session's agent process (the multi-server tests call this). */
  private closeLive(id: string): Promise<void> {
    return this.pool.closeLive(id);
  }

  /**
   * Import every chat's harness file into the store in the background, oldest first (I-121; the
   * server starts it once listening). Chats opened meanwhile are imported on open.
   */
  startTranscriptImport(): Promise<ImportSummary> {
    return this.transcripts.startBackgroundImport();
  }

  /** Write pending conversation changes now (synchronous; the exit hook). */
  flushTranscripts(): void {
    if (!this.ctx.store.isClosed) this.pool.flushTranscripts();
  }

  /** Drop every session lease we hold (synchronous; the exit hook, when dispose() didn't run). */
  releaseLeases(): void {
    this.ctx.leases?.releaseAll();
  }

  async dispose(): Promise<void> {
    const { ctx } = this;
    ctx.disposed = true;
    this.sync.dispose();
    ctx.leases?.stop();
    for (const off of this.unwatch.splice(0)) off();
    ctx.usage?.stop();
    ctx.agentTimers.clearAll();
    ctx.agents.flush();
    await Promise.all([...ctx.live.keys()].map((id) => this.pool.closeLive(id, { quiet: true })));
    await ctx.harnesses.dispose();
    ctx.store.dispose();
    ctx.leases?.releaseAll();
  }
}
