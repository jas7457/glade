import { mkdirSync } from "node:fs";
import type {
  AttachmentUploadResponse,
  CloseAgentResponse,
  CompactResult,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  CreateFolderRequest,
  ReorderChatListRequest,
  ReorderChatListResponse,
  DeepPartial,
  Folder,
  EnvironmentInfo,
  GenerateTitleResponse,
  AgentCatalogEntry,
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
  SideQuestionRequest,
  SideQuestionResponse,
  SlashCommand,
  SpawnAgentRequest,
  SpawnAgentResponse,
  ThinkingLevel,
  UiResponse,
  UpdateFolderRequest,
  UpdateProjectRequest,
  UpdateSessionRequest,
  UpdateWorkspaceRequest,
  HarnessUsageLimits,
  ServerMessage,
  WorkspaceDetail,
  WorkspaceSummary,
  WorktreeRemoval,
  WorktreeStatus,
} from "@glade/protocol";
import type { SessionText } from "../harness/types.js";
import { buildAgentCatalog } from "../harness/agent-catalog.js";
import { AgentTeam } from "./app/agent-team.js";
import { createAppContext, type AppContext, type AppServiceOptions, type Listener } from "./app/context.js";
import { LeaseSync } from "./app/lease-sync.js";
import { LivePool } from "./app/live-pool.js";
import { Projects } from "./app/projects.js";
import { Folders } from "./app/folders.js";
import { sanitizeSettingsPatch } from "./app/prompts.js";
import { Records } from "./app/records.js";
import { SessionActions } from "./app/session-actions.js";
import { SideQuestions } from "./app/side-questions.js";
import { Transcripts, type ImportSummary } from "./app/transcripts.js";
import { Sessions, type NewSessionKind } from "./app/sessions.js";
import { quickCompletionRunner, validateModelsPatch } from "./app/quick-tasks.js";
import { Titles } from "./app/titles.js";
import { Workspaces } from "./app/workspaces.js";
import type { AttachmentStore } from "./attachments.js";
import { LeaseManager } from "./leases.js";
import { UsageLimitsHub } from "./usage-hub.js";
import { LocalModelsService } from "./local-models/service.js";
import { validateLocalModelsPatch } from "./local-models/settings.js";
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
  private readonly sideQuestions: SideQuestions;
  private readonly sessions: Sessions;
  private readonly workspaces: Workspaces;
  private readonly projects: Projects;
  private readonly folders: Folders;
  private readonly team: AgentTeam;
  private readonly unwatch: Array<() => void> = [];
  /** Sequenced live sync to protocol-2 clients (I-122). */
  readonly sync: SyncHub;
  /** This server as an environment (I-123): id, name, capabilities. */
  readonly environment: Environment;
  /** Local models on this Mac (I-196): llama-server's models, load/unload. `start()` begins polling. */
  readonly localModels: LocalModelsService;

  constructor(options: AppServiceOptions & { sync?: SyncOptions; environment?: EnvironmentOptions }) {
    const ctx = createAppContext(options);
    this.ctx = ctx;
    this.environment = new Environment(ctx.store, options.environment);
    ctx.deviceName = () => this.environment.info().name;
    this.attachments = ctx.attachments;
    mkdirSync(options.scratchDir, { recursive: true });
    // Usage limits of every offered agent that reports them (I-191), the default's first.
    const usage = new UsageLimitsHub({
      harnesses: () => ctx.harnesses.list(),
      isOffered: (h) => ctx.harnesses.isOffered(h),
      defaultId: () => ctx.harnesses.default().id,
      broadcast: (m) => ctx.broadcast(m),
      log: options.log,
    });
    ctx.usage = usage.enabled ? usage : null;
    ctx.usage?.start();
    // Local models (I-196): chats using a llama.cpp model count as its users; a load or unload
    // refreshes the agents' model lists (pi only lists the models llama-server has loaded).
    this.localModels = new LocalModelsService({
      url: () => ctx.store.getSettings().localModels.url,
      broadcast: (m) => ctx.broadcast(m),
      users: () =>
        ctx.store
          .listSessions()
          .filter((s) => LocalModelsService.isLocalModel(s.model))
          .map((s) => ({ sessionId: s.id, model: s.model, running: this.records.summarizeSession(s).running })),
      onLoadedChange: () => void this.listModels(true).catch((err: Error) => options.log?.(`models refresh after a local model change failed: ${err.message}`)),
      log: options.log,
      ...options.localModels,
    });
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
    this.sideQuestions = new SideQuestions(ctx, this.records, this.pool, this.leaseSync);
    this.sessions = new Sessions(ctx, this.records, this.pool, this.leaseSync, this.actions, this.transcripts, {
      deliver: (targetId, text, behavior) => this.team.deliver(targetId, text, behavior),
    });
    this.folders = new Folders(ctx, this.records);
    this.workspaces = new Workspaces(ctx, this.records, this.pool, this.leaseSync, this.sessions, this.folders);
    this.projects = new Projects(ctx, this.records, this.workspaces, this.folders);
    this.team = new AgentTeam(ctx, this.records, this.pool, this.actions, this.sessions, this.titles);

    if (ctx.leases) {
      this.unwatch.push(ctx.store.onExternalChange((change) => this.leaseSync.applyExternalChange(change)));
      this.unwatch.push(ctx.agents.onExternalChange((ids) => this.records.pushSessions(ids)));
      ctx.store.watch();
      ctx.leases.start();
    }
    this.leaseSync.recoverInterruptedRuns();
    this.watchForLocalModels();

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
      folders: this.folders.listFolders(),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Folders in the chat list (I-165)
  // -------------------------------------------------------------------------------------------

  listFolders(): Folder[] {
    return this.folders.listFolders();
  }

  createFolder(req: CreateFolderRequest): Folder {
    return this.folders.createFolder(req);
  }

  updateFolder(id: string, req: UpdateFolderRequest): Folder {
    return this.folders.updateFolder(id, req);
  }

  /** `PUT /workspaces/order` (I-202): one container of a chat list in its new order. */
  reorderChatList(req: ReorderChatListRequest): ReorderChatListResponse {
    return this.folders.reorderChatList(req);
  }

  deleteFolder(id: string): void {
    this.folders.deleteFolder(id);
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

  /** `internal`: a server-side listener (e.g. the power tracker, I-147), not a client: it doesn't wake the usage poller. */
  subscribe(listener: Listener, options: { internal?: boolean } = {}): () => void {
    const { listeners, usage } = this.ctx;
    if (options.internal) {
      this.internalListeners.add(listener);
      listeners.add(listener);
      return () => {
        this.internalListeners.delete(listener);
        listeners.delete(listener);
      };
    }
    listeners.add(listener);
    const counted = () => {
      const clients = listeners.size - this.internalListeners.size;
      usage?.setClientCount(clients);
      this.localModels.setClientCount(clients);
    };
    counted();
    return () => {
      listeners.delete(listener);
      counted();
    };
  }
  private readonly internalListeners = new Set<Listener>();

  /** Latest subscription usage limits per agent (possibly stale), the default's first (I-191). */
  getUsageLimits(): HarnessUsageLimits[] {
    return this.ctx.usage?.entries() ?? [];
  }

  /** The `usage_limits` message for a newly connected client, or `null` when there are none. */
  usageLimitsMessage(): ServerMessage | null {
    return this.ctx.usage?.message() ?? null;
  }

  /** The `local_models` message for a newly connected client, or `null` before the first check (I-196). */
  localModelsMessage(): ServerMessage | null {
    return this.localModels.message();
  }

  /** Settings (a new model server URL) and chats (`usedBy`) feed the local models state (I-196). */
  private watchForLocalModels(): void {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = this.subscribe(
      (message) => {
        if (message.type === "settings") this.localModels.urlChanged();
        else if ((message.type === "session_upsert" || message.type === "session_removed") && !timer && this.localModels.current()?.models.length) {
          // Coalesced: sessions change often while chats run.
          timer = setTimeout(() => {
            timer = null;
            this.localModels.usersChanged();
          }, 100);
          timer.unref?.();
        }
      },
      { internal: true },
    );
    this.unwatch.push(() => {
      off();
      if (timer) clearTimeout(timer);
    });
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
    validateLocalModelsPatch(patch);
    validateModelsPatch(patch);
    const settings = this.ctx.store.updateSettings(sanitizeSettingsPatch(patch));
    this.ctx.broadcast({ type: "settings", settings });
    return settings;
  }

  /** The installed harnesses, the default first (`GET /api/harnesses`, I-065). */
  listHarnesses(): HarnessInfo[] {
    return this.ctx.harnesses.info();
  }

  /** Every agent this device knows about, installed or not (Settings → Agents, I-155). */
  agentCatalog(): AgentCatalogEntry[] {
    return buildAgentCatalog({ harnesses: this.ctx.harnesses, settings: this.ctx.store.getSettings() });
  }

  /**
   * The models of the harness with Glade's model picker (the default one, else the first offered
   * one that has models), tagged with its id (I-155), then those of the other offered harnesses
   * with pickers (I-173). Model settings use the first harness's; chats and new chats their own.
   */
  async listModels(force = false): Promise<ModelInfo[]> {
    const { harnesses } = this.ctx;
    const fallback = harnesses.default();
    const harness = fallback.info.capabilities.models !== false ? fallback : (harnesses.offered().find((h) => h.info.capabilities.models !== false) ?? fallback);
    // I-173: every offered harness with a model picker, each model tagged with its harness (the
    // default's first); clients pick a chat's list by `harness`. One failing harness costs only its list.
    const others = harnesses.offered().filter((h) => h !== harness && h.info.capabilities.models !== false);
    const lists = await Promise.all(
      [harness, ...others].map(async (h) => {
        const list = h === harness ? await h.listModels(force) : await h.listModels(force).catch((err: Error) => (this.ctx.options.log?.(`${h.id}: models failed: ${err.message}`), [] as ModelInfo[]));
        return list.map((m) => ({ ...m, harness: h.id }));
      }),
    );
    const models = lists.flat();
    // A forced refresh may have changed the list; let every client know.
    if (force) this.ctx.broadcast({ type: "models", models });
    return models;
  }

  /**
   * One-shot quick-task completion (I-097 commit messages): the quick-tasks agent and model
   * (I-198), else the default harness with Haiku when listed, else its default. `null` when unavailable.
   */
  async completeQuick(prompt: string, cwd: string): Promise<string | null> {
    const runner = await quickCompletionRunner(this.ctx.store.getSettings(), this.ctx.harnesses);
    if (!runner?.harness.complete) return null;
    return runner.harness.complete({ prompt, cwd, model: runner.model, timeoutMs: 60_000 });
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

  /** Push `open_chat`; → how many client windows got it (server-side listeners don't count). */
  requestOpenChat(sessionId: string): number {
    return Math.max(0, this.sessions.requestOpenChat(sessionId) - this.internalListeners.size);
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

  /** `/btw` / Ask Aside (I-140): answered by a separate model call; the agent never sees it. */
  askSideQuestion(id: string, req: SideQuestionRequest): Promise<SideQuestionResponse> {
    return this.sideQuestions.ask(id, req);
  }

  stopSideQuestion(id: string, questionId: string): void {
    this.sideQuestions.stop(id, questionId);
  }

  dismissSideQuestion(id: string, questionId: string): void {
    this.sideQuestions.dismiss(id, questionId);
  }

  setModel(id: string, model: ModelRef): Promise<void> {
    return this.actions.setModel(id, model);
  }

  setThinkingLevel(id: string, level: ThinkingLevel): Promise<void> {
    return this.actions.setThinkingLevel(id, level);
  }

  /** Switch a chat's permission mode (I-174). */
  setPermissionMode(id: string, mode: string): Promise<void> {
    return this.actions.setPermissionMode(id, mode);
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
    this.localModels.stop();
    ctx.agentTimers.clearAll();
    ctx.agents.flush();
    await Promise.all([...ctx.live.keys()].map((id) => this.pool.closeLive(id, { quiet: true })));
    await ctx.harnesses.dispose();
    ctx.store.dispose();
    ctx.leases?.releaseAll();
  }
}
