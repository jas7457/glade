import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import {
  AGENT_ENV,
  DEFAULT_IMAGE_LIMITS,
  MAX_ACTIVE_AGENTS,
  THINKING_LEVELS,
  applyAgentEvent,
  compareSessions,
  deriveChatStatus,
  firstMainSession,
  quickTitle,
  rollupWorkspace,
  sameModel,
  type AgentEvent,
  type CloseAgentResponse,
  type CompactResult,
  type CreateProjectRequest,
  type CreateSessionRequest,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResponse,
  type DeepPartial,
  type ListAgentsResponse,
  type MessageAgentRequest,
  type ModelInfo,
  type ModelRef,
  type OpenTarget,
  type Project,
  type PromptImage,
  type PromptRequest,
  type ReportDoneRequest,
  type ReportDoneResponse,
  type ServerMessage,
  type Session,
  type SessionDetail,
  type SessionSummary,
  type Settings,
  type SlashCommand,
  type SpawnAgentRequest,
  type SpawnAgentResponse,
  type ThinkingLevel,
  type Transcript,
  type UiRequest,
  type UiResponse,
  type UpdateProjectRequest,
  type UpdateSessionRequest,
  type UpdateWorkspaceRequest,
  type UsageLimits,
  type Workspace,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from "@pi-ui/protocol";
import type { AgentHarness, HarnessSession } from "../harness/types.js";
import type { Store } from "../store/store.js";
import {
  AgentRegistry,
  AgentTokens,
  CLOSE_GRACE_MS,
  IDLE_CLOSE_MS,
  MAIN_AGENT,
  agentInfo,
  buildRolePrompt,
  doneText,
  exitedText,
  messageText,
  normalizeAgentName,
  type AgentRecord,
} from "./agents.js";
import { createOpenIn, isOpenTarget, OpenInError, type OpenIn } from "./open-in.js";
import { createRevealPath, type RevealPath } from "./reveal.js";
import { UsageLimitsPoller } from "./usage-limits.js";

/** Byte size of base64 data once decoded (ignores whitespace and padding). */
export function decodedBase64Size(data: string): number {
  const clean = data.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

function formatMB(bytes: number): string {
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

/** Default title model when `settings.models.titleModel` is unset (used only if available). */
export const DEFAULT_TITLE_MODEL: ModelRef = { provider: "anthropic", id: "claude-haiku-4-5" };

/** True when `ids` holds exactly the ids in `expected`, each once. */
function sameIdSet(ids: string[], expected: string[]): boolean {
  const set = new Set(ids);
  return set.size === ids.length && ids.length === expected.length && expected.every((id) => set.has(id));
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 424 | 429 | 500 | 501,
    message: string,
  ) {
    super(message);
  }
}

interface LiveSession {
  session: HarnessSession;
  transcript: Transcript;
  pendingUi: Map<string, UiRequest>;
  /** Auto-close timers for dialogs with a timeout (the agent resolves them itself). */
  uiTimers: Map<string, NodeJS.Timeout>;
  /** Between run_start and run_end. Tracked here so it's correct while those events are handled. */
  running: boolean;
  lastUsedAt: number;
  unsubscribe: () => void;
}

export interface AppServiceOptions {
  store: Store;
  harness: AgentHarness;
  scratchDir: string;
  /** "Reveal in Finder" (injectable for tests). Default: `open -R` on macOS. */
  revealPath?: RevealPath;
  /** "Open in <app>" for project folders (injectable for tests). Default: `open -a` on macOS. */
  openIn?: OpenIn;
  log?: (msg: string) => void;
  /** App data folder; sub-agent records are kept in `agents.json` there (memory only if unset). */
  dataDir?: string;
  /** This server's base URL, handed to agents as `PI_UI_URL` (see {@link AppService.setServerUrl}). */
  serverUrl?: string;
  /** Called after a session's run settles (e.g. to refresh the search index). */
  onRunEnd?: (sessionId: string) => void;
}

/**
 * How a session is created. `subagent` sessions are for the agent API (I-037); `register` runs
 * once the session record exists, before its agent starts (the agent API records the sub-agent
 * there so the process starts with its role).
 */
export type NewSessionKind =
  | { kind: "main" }
  | { kind: "subagent"; parentSessionId: string; agentName: string; register?: (session: Session) => void };

type Listener = (message: ServerMessage) => void;

/**
 * Owns projects, workspaces, their sessions and the pool of live agent processes (one per
 * session). HTTP routes and the WebSocket are thin layers over this class, which keeps it easy
 * to test with the fake harness.
 */
export class AppService {
  /** sessionId -> live agent. */
  private readonly live = new Map<string, LiveSession>();
  private readonly opening = new Map<string, Promise<LiveSession>>();
  private readonly listeners = new Set<Listener>();
  private readonly usage: UsageLimitsPoller | null;
  /** sessionId -> number of clients currently viewing it. */
  private readonly viewers = new Map<string, number>();
  private readonly store: Store;
  private readonly harness: AgentHarness;
  /** Files written by `exportSession` this run; the only paths `revealPath` will show. */
  private readonly exported = new Set<string>();
  /** Agent API (I-037): sub-agent records, per-process tokens, timers, delivery queues. */
  private readonly agents: AgentRegistry;
  private readonly tokens = new AgentTokens();
  private readonly agentTimers = new Map<string, NodeJS.Timeout>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private serverUrl: string | null;

  constructor(private readonly options: AppServiceOptions) {
    this.store = options.store;
    this.harness = options.harness;
    this.agents = new AgentRegistry(options.dataDir);
    this.serverUrl = options.serverUrl ?? null;
    mkdirSync(options.scratchDir, { recursive: true });
    const getUsage = this.harness.getUsageLimits?.bind(this.harness);
    this.usage = getUsage
      ? new UsageLimitsPoller({ fetchLimits: getUsage, broadcast: (m) => this.broadcast(m), log: options.log })
      : null;
    this.usage?.start();
    this.recoverInterruptedRuns();
  }

  /**
   * Runs still flagged as in progress at startup were cut off (app quit, crash, server killed).
   * Mark them interrupted; `unread` + `lastRunFailed` make the sidebar show the failed marker.
   */
  private recoverInterruptedRuns(): void {
    for (const session of this.store.listSessions()) {
      if (!session.runInProgress) continue;
      this.saveSession({ ...session, runInProgress: false, interrupted: true, unread: true, lastRunFailed: true });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Push channel
  // -------------------------------------------------------------------------------------------

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.usage?.setClientCount(this.listeners.size);
    return () => {
      this.listeners.delete(listener);
      this.usage?.setClientCount(this.listeners.size);
    };
  }

  /** Latest subscription usage limits (possibly stale), or null if unavailable. */
  getUsageLimits(): UsageLimits | null {
    return this.usage?.current() ?? null;
  }

  private broadcast(message: ServerMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch (err) {
        this.options.log?.(`listener failed: ${(err as Error).message}`);
      }
    }
  }

  /** Track which sessions are on screen, so finished runs there don't get marked unread. */
  setViewing(sessionId: string, viewing: boolean): void {
    const count = (this.viewers.get(sessionId) ?? 0) + (viewing ? 1 : -1);
    if (count <= 0) this.viewers.delete(sessionId);
    else this.viewers.set(sessionId, count);
    if (viewing) {
      const session = this.store.getSession(sessionId);
      if (session?.unread) this.saveSession({ ...session, unread: false });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Settings + models
  // -------------------------------------------------------------------------------------------

  getSettings(): Settings {
    return this.store.getSettings();
  }

  updateSettings(patch: DeepPartial<Settings>): Settings {
    const settings = this.store.updateSettings(patch);
    this.broadcast({ type: "settings", settings });
    return settings;
  }

  async listModels(force = false): Promise<ModelInfo[]> {
    const models = await this.harness.listModels(force);
    // A forced refresh may have changed the list; let every client know.
    if (force) this.broadcast({ type: "models", models });
    return models;
  }

  // -------------------------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------------------------

  /** Projects in their manual order (`sortOrder` ascending). */
  listProjects(): Project[] {
    return [...this.store.listProjects()].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  createProject(req: CreateProjectRequest): Project {
    if (!req.path?.trim()) throw new HttpError(400, "A folder path is required");
    const path = resolve(req.path.trim().replace(/^~(?=$|\/)/, homedir()));
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      /* missing */
    }
    if (!isDir) throw new HttpError(400, `Not a folder: ${path}`);
    const existing = this.store.listProjects().find((p) => p.path === path);
    if (existing) return existing;
    const now = Date.now();
    const orders = this.store.listProjects().map((p) => p.sortOrder);
    const project: Project = {
      id: randomUUID(),
      name: req.name?.trim() || basename(path) || path,
      path,
      // New projects go to the top of the manual order.
      sortOrder: orders.length ? Math.min(...orders) - 1 : 0,
      createdAt: now,
      lastActivityAt: now,
    };
    this.store.upsertProject(project);
    this.broadcast({ type: "project_upsert", project });
    return project;
  }

  updateProject(id: string, req: UpdateProjectRequest): Project {
    const project = this.requireProject(id);
    const next: Project = {
      ...project,
      ...(req.name !== undefined && req.name.trim() ? { name: req.name.trim() } : {}),
    };
    this.store.upsertProject(next);
    this.broadcast({ type: "project_upsert", project: next });
    return next;
  }

  /** Set the manual project order. `ids` must be exactly the current projects. */
  reorderProjects(ids: string[]): Project[] {
    const projects = this.store.listProjects();
    if (!sameIdSet(ids, projects.map((p) => p.id))) {
      throw new HttpError(400, "ids must list every project exactly once");
    }
    ids.forEach((id, sortOrder) => {
      const project = this.store.getProject(id)!;
      if (project.sortOrder === sortOrder) return;
      const next = { ...project, sortOrder };
      this.store.upsertProject(next);
      this.broadcast({ type: "project_upsert", project: next });
    });
    return this.listProjects();
  }

  /** Open a project's folder in another app (e.g. VS Code). */
  async openProject(id: string, app: unknown): Promise<void> {
    const project = this.requireProject(id);
    if (!isOpenTarget(app)) throw new HttpError(400, `Unknown app: ${String(app)}`);
    try {
      await (this.options.openIn ?? createOpenIn())(app satisfies OpenTarget, project.path);
    } catch (err) {
      if (err instanceof OpenInError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  /** Removes the project and all of its workspaces (including their session files). */
  async deleteProject(id: string): Promise<void> {
    this.requireProject(id);
    for (const workspace of this.store.listWorkspaces().filter((w) => w.projectId === id)) {
      await this.deleteWorkspace(workspace.id);
    }
    this.store.removeProject(id);
    this.broadcast({ type: "project_removed", projectId: id });
  }

  private requireProject(id: string): Project {
    const project = this.store.getProject(id);
    if (!project) throw new HttpError(404, "Project not found");
    return project;
  }

  // -------------------------------------------------------------------------------------------
  // Records, summaries and pushes
  // -------------------------------------------------------------------------------------------

  private requireWorkspace(id: string): Workspace {
    const workspace = this.store.getWorkspace(id);
    if (!workspace) throw new HttpError(404, "Workspace not found");
    return workspace;
  }

  private requireSession(id: string): Session {
    const session = this.store.getSession(id);
    if (!session) throw new HttpError(404, "Session not found");
    return session;
  }

  private summarizeSession(session: Session): SessionSummary {
    const live = this.live.get(session.id);
    const running = live?.running ?? false;
    const pendingInputs = live?.pendingUi.size ?? 0;
    return { ...session, running, pendingInputs, status: deriveChatStatus({ running, pendingInputs, unread: session.unread }) };
  }

  private summarizeWorkspace(workspace: Workspace): WorkspaceSummary {
    return rollupWorkspace(workspace, this.store.listSessions(workspace.id).map((s) => this.summarizeSession(s)));
  }

  /** Main sessions first, then sub-agents; each by creation. */
  private sessionsOf(workspaceId: string): SessionSummary[] {
    const all = this.store.listSessions(workspaceId).sort(compareSessions);
    return [...all.filter((s) => s.kind === "main"), ...all.filter((s) => s.kind !== "main")].map((s) => this.summarizeSession(s));
  }

  /** Persist + push a workspace (with its rolled-up status). */
  private saveWorkspace(workspace: Workspace): WorkspaceSummary {
    this.store.upsertWorkspace(workspace);
    const summary = this.summarizeWorkspace(workspace);
    this.broadcast({ type: "workspace_upsert", workspace: summary });
    return summary;
  }

  /** Push the workspace again because one of its sessions changed. `touch` bumps its activity. */
  private refreshWorkspace(workspaceId: string, touch = false): void {
    const workspace = this.store.getWorkspace(workspaceId);
    if (!workspace) return;
    this.saveWorkspace(touch ? { ...workspace, lastActivityAt: Date.now() } : workspace);
  }

  /** Persist + push a session, then its workspace (status roll-up). */
  private saveSession(session: Session, { touch = false } = {}): SessionSummary {
    this.store.upsertSession(session);
    const summary = this.summarizeSession(session);
    this.broadcast({ type: "session_upsert", session: summary });
    this.refreshWorkspace(session.workspaceId, touch);
    return summary;
  }

  private emitSessionEvent(session: Pick<Session, "id" | "workspaceId">, event: AgentEvent): void {
    this.broadcast({ type: "session_event", sessionId: session.id, workspaceId: session.workspaceId, event });
  }

  // -------------------------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------------------------

  listWorkspaces(): WorkspaceSummary[] {
    return this.store.listWorkspaces().map((w) => this.summarizeWorkspace(w));
  }

  /** All sessions (or one workspace's), main sessions first. */
  listSessions(workspaceId?: string): SessionSummary[] {
    if (workspaceId !== undefined) {
      this.requireWorkspace(workspaceId);
      return this.sessionsOf(workspaceId);
    }
    return this.store.listWorkspaces().flatMap((w) => this.sessionsOf(w.id));
  }

  getWorkspaceDetail(id: string): WorkspaceDetail {
    const workspace = this.requireWorkspace(id);
    return { workspace: this.summarizeWorkspace(workspace), sessions: this.sessionsOf(id) };
  }

  /** A new workspace with its first main session (started, and prompted if a prompt is given). */
  async createWorkspace(req: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
    const project = req.projectId ? this.requireProject(req.projectId) : null;
    const now = Date.now();
    const workspace: Workspace = {
      id: randomUUID(),
      projectId: project?.id ?? null,
      title: req.prompt ? quickTitle(req.prompt) : "New chat",
      titleSource: "auto",
      cwd: project?.path ?? this.options.scratchDir,
      pinned: false,
      createdAt: now,
      lastActivityAt: now,
      layout: null,
    };
    this.store.upsertWorkspace(workspace);
    try {
      const session = await this.createSession(workspace.id, req);
      return { ...this.getWorkspaceDetail(workspace.id), session };
    } catch (err) {
      // Don't leave a broken, empty workspace behind.
      await this.deleteWorkspace(workspace.id).catch(() => {});
      throw err;
    }
  }

  async updateWorkspace(id: string, req: UpdateWorkspaceRequest): Promise<WorkspaceSummary> {
    const workspace = this.requireWorkspace(id);
    const next: Workspace = { ...workspace };
    if (req.title !== undefined) {
      const title = req.title.trim();
      if (!title) throw new HttpError(400, "Title cannot be empty");
      next.title = title;
      next.titleSource = "user";
      // With a single tab, the tab and the workspace are the same thing to the user.
      const main = this.store.listSessions(id).filter((s) => s.kind === "main");
      if (main.length === 1) await this.renameSession(main[0]!, title);
    }
    if (req.pinned === true && !workspace.pinned) {
      // Newly pinned workspaces go to the top of their list's pinned group.
      const orders = this.pinnedWorkspaces(workspace.projectId).map((w) => w.pinOrder ?? 0);
      next.pinned = true;
      next.pinOrder = orders.length ? Math.min(...orders) - 1 : 0;
    } else if (req.pinned === false) {
      next.pinned = false;
      delete next.pinOrder;
    }
    if (req.layout !== undefined) next.layout = req.layout;
    return this.saveWorkspace(next);
  }

  /** Pinned workspaces of one list (a project, or standalone = null), in pin order. */
  private pinnedWorkspaces(projectId: string | null): Workspace[] {
    return this.store
      .listWorkspaces()
      .filter((w) => w.pinned && w.projectId === projectId)
      .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
  }

  /** Reorder the pinned workspaces of one list. `ids` must be exactly that list's pinned workspaces. */
  reorderPinnedWorkspaces(projectId: string | null, ids: string[]): WorkspaceSummary[] {
    if (projectId !== null) this.requireProject(projectId);
    if (!sameIdSet(ids, this.pinnedWorkspaces(projectId).map((w) => w.id))) {
      throw new HttpError(400, "ids must list every pinned workspace of that list exactly once");
    }
    ids.forEach((id, pinOrder) => {
      const workspace = this.store.getWorkspace(id)!;
      if (workspace.pinOrder !== pinOrder) this.saveWorkspace({ ...workspace, pinOrder });
    });
    return this.pinnedWorkspaces(projectId).map((w) => this.summarizeWorkspace(w));
  }

  /** Delete a workspace, stopping its agents and permanently deleting all of its session files. */
  async deleteWorkspace(id: string): Promise<void> {
    this.requireWorkspace(id);
    for (const session of this.store.listSessions(id)) {
      await this.disposeSession(session);
      this.forgetAgent(session.id);
    }
    this.store.removeWorkspace(id);
    this.broadcast({ type: "workspace_removed", workspaceId: id });
  }

  // -------------------------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------------------------

  /**
   * Add a session to a workspace and start its agent (plus the first prompt, if given). Main
   * sessions are tabs the user opens; `subagent` sessions are spawned by another session of the
   * same workspace (agent API, I-037).
   */
  async createSession(workspaceId: string, req: CreateSessionRequest, how: NewSessionKind = { kind: "main" }): Promise<SessionDetail> {
    this.requireWorkspace(workspaceId);
    if (how.kind === "subagent") {
      const parent = this.requireSession(how.parentSessionId);
      if (parent.workspaceId !== workspaceId) throw new HttpError(400, "The parent session belongs to another workspace");
    }
    const settings = this.store.getSettings();
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      workspaceId,
      kind: how.kind,
      parentSessionId: how.kind === "subagent" ? how.parentSessionId : null,
      agentName: how.kind === "subagent" ? how.agentName : null,
      title: how.kind === "subagent" ? how.agentName : req.prompt ? quickTitle(req.prompt) : "New chat",
      titleSource: how.kind === "subagent" ? "user" : "auto",
      harness: this.harness.id,
      sessionRef: null,
      unread: false,
      createdAt: now,
      lastActivityAt: now,
      model: req.model ?? settings.models.defaultModel,
      thinkingLevel: req.thinkingLevel ?? settings.models.defaultThinkingLevel,
    };
    this.saveSession(session);
    if (how.kind === "subagent") how.register?.(session);
    try {
      const live = await this.ensureLive(session.id);
      if (req.prompt?.trim() || req.images?.length) {
        await this.sendPrompt(session.id, { text: req.prompt ?? "", images: req.images }, live);
      }
    } catch (err) {
      await this.disposeSession(this.store.getSession(session.id) ?? session).catch(() => {});
      this.forgetAgent(session.id);
      this.store.removeSession(session.id);
      this.broadcast({ type: "session_removed", sessionId: session.id, workspaceId });
      this.refreshWorkspace(workspaceId);
      throw err;
    }
    return this.getSessionDetail(session.id);
  }

  async getSessionDetail(id: string): Promise<SessionDetail> {
    this.requireSession(id);
    const live = await this.ensureLive(id);
    return {
      session: this.summarizeSession(this.requireSession(id)),
      transcript: live.transcript,
      state: live.session.getState(),
      pendingUiRequests: [...live.pendingUi.values()],
    };
  }

  async updateSession(id: string, req: UpdateSessionRequest): Promise<SessionSummary> {
    let session = this.requireSession(id);
    if (req.title !== undefined) {
      const title = req.title.trim();
      if (!title) throw new HttpError(400, "Title cannot be empty");
      await this.renameSession(session, title);
      session = this.requireSession(id);
    }
    const next: Session = { ...session };
    if (req.unread !== undefined) next.unread = req.unread;
    if (req.interrupted === false) delete next.interrupted;
    return this.saveSession(next);
  }

  private async renameSession(session: Session, title: string): Promise<void> {
    this.saveSession({ ...session, title, titleSource: "user" });
    await this.live.get(session.id)?.session.setTitle(title).catch(() => {});
  }

  /**
   * Close a tab: stops the agent and permanently deletes the session file, plus any sub-agents
   * it spawned. The last main session can't be deleted (delete the workspace instead).
   */
  async deleteSession(id: string): Promise<void> {
    const session = this.requireSession(id);
    const siblings = this.store.listSessions(session.workspaceId);
    if (session.kind === "main" && siblings.filter((s) => s.kind === "main").length <= 1) {
      throw new HttpError(409, "A workspace needs at least one main session; delete the workspace instead");
    }
    const doomed = [session, ...this.descendantsOf(session.id, siblings)];
    const doomedIds = new Set(doomed.map((s) => s.id));
    for (const s of doomed) {
      await this.disposeSession(s);
      const agent = this.agents.get(s.id);
      if (agent && !agent.closed && agent.doneAt === null && !doomedIds.has(agent.parentSessionId)) {
        this.deliver(agent.parentSessionId, exitedText(agent.name, "Exited before calling report_done (the user closed its tab)."), "followUp");
      }
      this.forgetAgent(s.id);
      this.store.removeSession(s.id);
      this.broadcast({ type: "session_removed", sessionId: s.id, workspaceId: s.workspaceId });
    }
    this.refreshWorkspace(session.workspaceId);
  }

  /** Sub-agents spawned by `id`, recursively. */
  private descendantsOf(id: string, sessions: Session[]): Session[] {
    const children = sessions.filter((s) => s.parentSessionId === id);
    return children.flatMap((c) => [c, ...this.descendantsOf(c.id, sessions)]);
  }

  /** Stop a session's agent and delete its file (the record is left to the caller). */
  private async disposeSession(session: Session): Promise<void> {
    await this.closeLive(session.id);
    if (session.sessionRef) await this.harness.deleteSession(session.sessionRef).catch(() => {});
    this.viewers.delete(session.id);
  }

  /** A prompt from the user (the HTTP API). */
  async prompt(id: string, req: PromptRequest): Promise<void> {
    this.requireSession(id);
    // Typing in a sub-agent's tab means the user is using it: never close it automatically.
    const agent = this.agents.get(id);
    if (agent && (!agent.userEngaged || agent.closed || agent.closing)) {
      this.clearAgentTimer(id);
      this.agents.update(id, { userEngaged: true, closed: false, closing: false });
    }
    const live = await this.ensureLive(id);
    await this.sendPrompt(id, req, live);
  }

  private async sendPrompt(id: string, req: PromptRequest, live: LiveSession): Promise<void> {
    if (!req.text.trim() && !req.images?.length) throw new HttpError(400, "Message is empty");
    await this.checkImageSizes(req.images, live);
    const isFirst = !live.transcript.messages.some((m) => m.role === "user");
    live.lastUsedAt = Date.now();
    const behavior = req.behavior ?? this.store.getSettings().general.busyBehavior;
    await live.session.prompt({ ...req, behavior });
    const session = this.requireSession(id);
    const next: Session = { ...session, lastActivityAt: Date.now() };
    delete next.interrupted; // any new prompt dismisses the "interrupted" state
    const retitle = isFirst && session.titleSource === "auto" && !!req.text.trim();
    if (retitle) {
      next.title = quickTitle(req.text);
      void this.generateTitle(id, req.text).catch((err: Error) => this.options.log?.(`title generation failed: ${err.message}`));
    }
    this.saveSession(next, { touch: true });
    if (retitle) {
      this.followTitle(next);
      await live.session.setTitle(next.title).catch(() => {});
    }
    this.touchProject(this.store.getWorkspace(session.workspaceId)?.projectId ?? null);
  }

  /** An `auto` workspace title follows the title of its first main session. */
  private followTitle(session: Session): void {
    const workspace = this.store.getWorkspace(session.workspaceId);
    if (!workspace || workspace.titleSource !== "auto" || workspace.title === session.title) return;
    if (firstMainSession(this.store.listSessions(workspace.id), workspace.id)?.id !== session.id) return;
    this.saveWorkspace({ ...workspace, title: session.title });
  }

  /**
   * Reject images over the model's size limit with a clear message instead of letting the
   * provider fail the run. Clients downscale before sending, so this is only a safety net.
   */
  private async checkImageSizes(images: PromptImage[] | undefined, live: LiveSession): Promise<void> {
    if (!images?.length) return;
    const model = live.session.getState().model;
    const models = model ? await this.harness.listModels().catch(() => [] as ModelInfo[]) : [];
    const limits = models.find((m) => sameModel(m, model))?.imageLimits ?? DEFAULT_IMAGE_LIMITS;
    images.forEach((image, i) => {
      const bytes = decodedBase64Size(image.data);
      if (bytes > limits.maxBytes) {
        const which = images.length > 1 ? `Image ${i + 1}` : "The image";
        throw new HttpError(400, `${which} is too large (${formatMB(bytes)}); this model accepts images up to ${formatMB(limits.maxBytes)}`);
      }
    });
  }

  private async generateTitle(id: string, firstMessage: string): Promise<void> {
    const settings = this.store.getSettings();
    if (!settings.general.generateTitles || !this.harness.generateTitle) return;
    const session = this.store.getSession(id);
    const workspace = session && this.store.getWorkspace(session.workspaceId);
    if (!session || !workspace) return;
    const title = await this.harness.generateTitle({
      firstMessage,
      cwd: workspace.cwd,
      model: settings.models.titleModel ?? (await this.defaultTitleModel()) ?? session.model,
    });
    const current = this.store.getSession(id);
    if (!title || !current || current.titleSource !== "auto") return;
    const next = { ...current, title };
    this.saveSession(next);
    this.followTitle(next);
    await this.live.get(id)?.session.setTitle(title).catch(() => {});
  }

  /** Titles use a cheap, fast model by default (Haiku) when it's available. */
  private async defaultTitleModel(): Promise<ModelRef | null> {
    const models = await this.harness.listModels().catch(() => [] as ModelInfo[]);
    return models.some((m) => sameModel(m, DEFAULT_TITLE_MODEL)) ? DEFAULT_TITLE_MODEL : null;
  }

  async abort(id: string): Promise<void> {
    this.requireSession(id);
    const live = this.live.get(id);
    if (live) await live.session.abort();
  }

  async setModel(id: string, model: ModelRef): Promise<void> {
    this.requireSession(id);
    const live = await this.ensureLive(id);
    await live.session.setModel(model);
  }

  async setThinkingLevel(id: string, level: ThinkingLevel): Promise<void> {
    this.requireSession(id);
    const live = await this.ensureLive(id);
    await live.session.setThinkingLevel(level);
  }

  // -------------------------------------------------------------------------------------------
  // Slash-command support (pi-ui's own built-ins run in the web app; see docs/ARCHITECTURE.md)
  // -------------------------------------------------------------------------------------------

  /** The harness's slash commands (extensions, skills, prompt templates) for a session. */
  async listCommands(id: string): Promise<SlashCommand[]> {
    this.requireSession(id);
    const live = await this.ensureLive(id);
    return live.session.listCommands ? live.session.listCommands() : [];
  }

  async compact(id: string, instructions?: string): Promise<CompactResult> {
    this.requireSession(id);
    const live = await this.ensureLive(id);
    if (!live.session.compact) throw new HttpError(409, "This agent can't compact its context");
    if (live.running) throw new HttpError(409, "Wait for the current reply to finish before compacting");
    if (live.session.getState().isCompacting) throw new HttpError(409, "Already compacting");
    live.lastUsedAt = Date.now();
    return live.session.compact(instructions?.trim() || undefined);
  }

  /** Export the session to an HTML file; optionally reveal it in Finder. */
  async exportSession(id: string, options: { reveal?: boolean } = {}): Promise<{ path: string }> {
    this.requireSession(id);
    const live = await this.ensureLive(id);
    if (!live.session.exportHtml) throw new HttpError(409, "This agent can't export chats");
    const path = await live.session.exportHtml();
    this.exported.add(path);
    if (options.reveal) await this.revealPath(path);
    return { path };
  }

  /** Reveal a file this server exported (arbitrary paths are refused). */
  async revealPath(path: string): Promise<void> {
    if (!this.exported.has(path)) throw new HttpError(404, "Unknown file");
    await (this.options.revealPath ?? createRevealPath())(path);
  }

  respondToUi(id: string, response: UiResponse): void {
    const session = this.requireSession(id);
    const live = this.live.get(id);
    if (!live) throw new HttpError(404, "Session is not running");
    live.session.respondToUi(response);
    const wasPending = this.removePendingUi(live, response.id);
    this.emitSessionEvent(session, { type: "ui_request_closed", id: response.id });
    if (wasPending) this.saveSession(session); // pendingInputs/status changed
  }

  private touchProject(projectId: string | null): void {
    if (!projectId) return;
    const project = this.store.getProject(projectId);
    if (!project) return;
    const next = { ...project, lastActivityAt: Date.now() };
    this.store.upsertProject(next);
    this.broadcast({ type: "project_upsert", project: next });
  }

  // -------------------------------------------------------------------------------------------
  // Agent API (I-037): sub-agents as `subagent` sessions; see http/agents.ts
  // -------------------------------------------------------------------------------------------

  /** This server's base URL for agents (`PI_UI_URL`); set once listening. Applies to new processes. */
  setServerUrl(url: string): void {
    this.serverUrl = url.replace(/\/+$/, "");
  }

  /** Environment for a session's new agent process: its identity for the agent API. */
  private agentEnv(session: Session): Record<string, string> {
    if (!this.serverUrl) return {};
    const env: Record<string, string> = {
      [AGENT_ENV.url]: this.serverUrl,
      [AGENT_ENV.sessionId]: session.id,
      [AGENT_ENV.token]: this.tokens.issue(session.id),
    };
    const agent = this.agents.get(session.id);
    if (agent) env[AGENT_ENV.agentName] = agent.name;
    return env;
  }

  /** The session a token belongs to (401 for unknown, revoked or stale tokens). */
  authenticateAgent(token: string | undefined): Session {
    const sessionId = token ? this.tokens.sessionFor(token) : undefined;
    const session = sessionId ? this.store.getSession(sessionId) : undefined;
    if (!session) throw new HttpError(401, "Invalid agent token");
    return session;
  }

  /** Start a sub-agent in the caller's workspace (same folder); its first prompt is the task. */
  async spawnAgent(callerId: string, req: SpawnAgentRequest): Promise<SpawnAgentResponse> {
    const caller = this.requireSession(callerId);
    if (caller.kind !== "main") throw new HttpError(403, "Sub-agents can't spawn agents");
    const name = normalizeAgentName(req.name ?? "");
    if (!name || name === MAIN_AGENT) throw new HttpError(400, `Invalid agent name "${req.name}"`);
    const task = req.task?.trim();
    if (!task) throw new HttpError(400, "task is required");
    const keepOpenReason = req.keepOpenReason?.trim() || null;
    if (req.keepOpen && !keepOpenReason) {
      throw new HttpError(400, "keep_open needs keep_open_reason: name the concrete follow-up you expect to send. If there isn't one, omit keep_open.");
    }
    const model = req.model ? await this.resolveModel(req.model) : caller.model;
    if (req.thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(req.thinking)) {
      throw new HttpError(400, `thinking must be one of ${THINKING_LEVELS.join(", ")}`);
    }
    const thinkingLevel = (req.thinking as ThinkingLevel | undefined) ?? caller.thinkingLevel;

    // No awaits from here until the record is registered, so parallel spawns can't overshoot.
    if (this.agents.findActive(caller.id, name)) throw new HttpError(409, `An agent named "${name}" is already running. Pick another name.`);
    const active = this.agents.activeIn(caller.workspaceId);
    if (active.length >= MAX_ACTIVE_AGENTS) {
      throw new HttpError(429, `Limit reached: ${MAX_ACTIVE_AGENTS} active agents. Close one first (close_agent).`);
    }
    const agent = req.agent?.trim() || null;
    const tools = req.tools?.length ? [...new Set([...req.tools, "report_done", "message_agent"])] : null;
    const systemPrompt = buildRolePrompt({
      name,
      teammates: active.filter((r) => r.parentSessionId === caller.id).map((r) => r.name),
      agent,
      agentPrompt: req.agentPrompt,
    });
    let record: AgentRecord | undefined;
    const detail = await this.createSession(
      caller.workspaceId,
      { prompt: task, model, thinkingLevel },
      {
        kind: "subagent",
        parentSessionId: caller.id,
        agentName: name,
        register: (session) => {
          record = this.agents.upsert({
            sessionId: session.id,
            parentSessionId: caller.id,
            workspaceId: caller.workspaceId,
            name,
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
        },
      },
    );
    return { agent: agentInfo(this.agents.get(detail.session.id) ?? record!, detail.session.running) };
  }

  /** `provider/id`, or a bare id matched against the harness's models. */
  private async resolveModel(value: string): Promise<ModelRef> {
    const slash = value.indexOf("/");
    if (slash > 0 && slash < value.length - 1) return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
    const models = await this.harness.listModels().catch(() => [] as ModelInfo[]);
    const match = models.find((m) => m.id === value);
    if (!match) throw new HttpError(400, `Unknown model "${value}"`);
    return { provider: match.provider, id: match.id };
  }

  /** Message the parent (`to: "main"`, sub-agents only) or an active sub-agent of the team. */
  messageAgent(callerId: string, req: MessageAgentRequest): void {
    const caller = this.requireSession(callerId);
    const self = this.agents.get(caller.id);
    const text = req.text?.trim();
    if (!text) throw new HttpError(400, "text is required");
    if (req.to === MAIN_AGENT) {
      if (!self) throw new HttpError(400, 'You are the main session; message a sub-agent by name');
      this.deliver(self.parentSessionId, messageText(self.name, req.text), "steer");
      return;
    }
    const target = this.agents.findActive(self ? self.parentSessionId : caller.id, normalizeAgentName(req.to ?? ""));
    if (!target || target.sessionId === caller.id) throw new HttpError(404, `No active agent named "${req.to}".`);
    this.deliver(target.sessionId, messageText(self?.name ?? MAIN_AGENT, req.text), "steer");
  }

  /** The caller's team: its sub-agents (main) or its teammates (sub-agent). */
  listAgents(callerId: string): ListAgentsResponse {
    const caller = this.requireSession(callerId);
    const self = this.agents.get(caller.id);
    const team = this.agents.childrenOf(self ? self.parentSessionId : caller.id);
    return {
      self: { sessionId: caller.id, role: self ? "subagent" : "main", name: self?.name ?? null },
      agents: team.map((r) => agentInfo(r, this.live.get(r.sessionId)?.running ?? null)),
    };
  }

  /** Stop one of the caller's sub-agents: now if it's idle, else when its turn ends (30s at most). */
  async closeAgent(callerId: string, name: string): Promise<CloseAgentResponse> {
    this.requireSession(callerId);
    const target = this.agents.findActive(callerId, normalizeAgentName(name ?? ""));
    if (!target) throw new HttpError(404, `No active agent named "${name}".`);
    if (!this.live.get(target.sessionId)?.running) {
      await this.stopAgent(target.sessionId);
      return { closed: true };
    }
    this.agents.update(target.sessionId, { closing: true });
    this.setAgentTimer(target.sessionId, CLOSE_GRACE_MS, () => void this.stopAgent(target.sessionId));
    return { closed: false };
  }

  /** A sub-agent's result: delivered to its parent; the sub-agent stops after this turn unless kept open. */
  reportAgentDone(callerId: string, req: ReportDoneRequest): ReportDoneResponse {
    this.requireSession(callerId);
    const self = this.agents.get(callerId);
    if (!self) throw new HttpError(403, "Only sub-agents can report_done");
    const summary = req.summary?.trim();
    if (!summary) throw new HttpError(400, "summary is required");
    const closing = self.autoClose && !req.keepOpen && !self.userEngaged;
    const record = this.agents.update(callerId, { doneAt: Date.now(), result: summary, closing })!;
    this.deliver(self.parentSessionId, doneText(record, summary), "followUp");
    if (closing) {
      // Normally at the end of the current turn (run_end); right away if it isn't running.
      if (!this.live.get(callerId)?.running) void this.stopAgent(callerId);
    } else if (!self.userEngaged) {
      this.setAgentTimer(callerId, IDLE_CLOSE_MS, () => {
        const current = this.agents.get(callerId);
        if (current && !current.closed && !current.userEngaged && !this.live.get(callerId)?.running) void this.stopAgent(callerId);
      });
    }
    return { closing };
  }

  /** Stop a sub-agent's process, keeping its tab and transcript (it can be reopened by the user). */
  private async stopAgent(sessionId: string): Promise<void> {
    this.clearAgentTimer(sessionId);
    if (!this.agents.get(sessionId)) return;
    this.agents.update(sessionId, { closing: false, closed: true });
    await this.closeLive(sessionId);
    const session = this.store.getSession(sessionId);
    if (session) this.saveSession(session);
  }

  /**
   * Send `text` to a session as a prompt (a follow-up or steer if it's running), in order per
   * target. Failures are logged; the caller's request has already succeeded.
   */
  private deliver(targetId: string, text: string, behavior: "steer" | "followUp"): void {
    const previous = this.deliveries.get(targetId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (!this.store.getSession(targetId)) return;
        const live = await this.ensureLive(targetId);
        await this.sendPrompt(targetId, { text, behavior }, live);
      })
      .catch((err: Error) => this.options.log?.(`agent-teams: delivery to ${targetId} failed: ${err.message}`));
    this.deliveries.set(targetId, next);
    void next.finally(() => {
      if (this.deliveries.get(targetId) === next) this.deliveries.delete(targetId);
    });
  }

  /** Wait for queued deliveries (tests). */
  async settleAgentDeliveries(): Promise<void> {
    while (this.deliveries.size) await Promise.all([...this.deliveries.values()]);
  }

  private setAgentTimer(sessionId: string, ms: number, fn: () => void): void {
    this.clearAgentTimer(sessionId);
    const timer = setTimeout(() => {
      this.agentTimers.delete(sessionId);
      fn();
    }, ms);
    timer.unref();
    this.agentTimers.set(sessionId, timer);
  }

  private clearAgentTimer(sessionId: string): void {
    const timer = this.agentTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.agentTimers.delete(sessionId);
  }

  /** Drop a deleted session's sub-agent record (tokens go with its process). */
  private forgetAgent(sessionId: string): void {
    this.clearAgentTimer(sessionId);
    this.tokens.revoke(sessionId);
    this.agents.remove(sessionId);
  }

  // -------------------------------------------------------------------------------------------
  // Live session pool (one agent process per session)
  // -------------------------------------------------------------------------------------------

  /** Number of agent processes currently alive (for tests/diagnostics). */
  get liveCount(): number {
    return this.live.size;
  }

  private ensureLive(id: string): Promise<LiveSession> {
    const existing = this.live.get(id);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return Promise.resolve(existing);
    }
    let pending = this.opening.get(id);
    if (!pending) {
      pending = this.openLive(id).finally(() => this.opening.delete(id));
      this.opening.set(id, pending);
    }
    return pending;
  }

  private async openLive(id: string): Promise<LiveSession> {
    const record = this.requireSession(id);
    const workspace = this.requireWorkspace(record.workspaceId);
    mkdirSync(workspace.cwd, { recursive: true });
    const agent = this.agents.get(id);
    let session: HarnessSession;
    try {
      session = await this.harness.openSession({
        cwd: workspace.cwd,
        sessionRef: record.sessionRef,
        model: record.model,
        thinkingLevel: record.thinkingLevel,
        env: this.agentEnv(record),
        ...(agent ? { appendSystemPrompt: agent.systemPrompt, ...(agent.tools ? { tools: agent.tools } : {}) } : {}),
      });
    } catch (err) {
      this.tokens.revoke(id);
      throw err;
    }
    const transcript = await session.loadTranscript();
    const live: LiveSession = {
      session,
      transcript,
      pendingUi: new Map(),
      uiTimers: new Map(),
      running: session.getState().isRunning,
      lastUsedAt: Date.now(),
      unsubscribe: () => {},
    };
    const offEvent = session.onEvent((event) => this.handleEvent(id, live, event));
    const offExit = session.onExit((error) => this.handleExit(id, live, error));
    live.unsubscribe = () => {
      offEvent();
      offExit();
    };
    this.live.set(id, live);

    // Persist the session reference / effective model once known.
    const state = session.getState();
    const current = this.requireSession(id);
    if (current.sessionRef !== session.sessionRef || !current.model) {
      this.saveSession({
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

  private handleEvent(id: string, live: LiveSession, event: AgentEvent): void {
    live.transcript = applyAgentEvent(live.transcript, event);
    if (event.type === "run_start") live.running = true;
    if (event.type === "run_end") live.running = false;
    if (event.type === "ui_request") this.addPendingUi(id, live, event.request);
    if (event.type === "ui_request_closed") this.removePendingUi(live, event.id);

    const session = this.store.getSession(id);
    if (!session) return;
    this.emitSessionEvent(session, event);

    if (event.type === "run_start") {
      const next: Session = { ...session, lastActivityAt: Date.now(), lastRunFailed: false, runInProgress: true };
      delete next.interrupted;
      this.saveSession(next, { touch: true });
    } else if (event.type === "run_end") {
      this.options.onRunEnd?.(id);
      this.usage?.onRunEnd();
      this.clearPendingUi(live);
      live.lastUsedAt = Date.now();
      this.saveSession(
        { ...session, lastActivityAt: Date.now(), runInProgress: false, unread: session.unread || !this.viewers.has(id) },
        { touch: true },
      );
      if (this.agents.get(id)?.closing) void this.stopAgent(id);
      this.evictIdle();
    } else if (event.type === "ui_request" || event.type === "ui_request_closed") {
      this.saveSession(session); // pendingInputs/status changed
    } else if (
      (event.type === "error" || (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error")) &&
      !session.lastRunFailed
    ) {
      this.saveSession({ ...session, lastRunFailed: true });
    } else if (event.type === "state" && (event.state.model || event.state.thinkingLevel)) {
      const next = {
        ...session,
        model: event.state.model ?? session.model,
        thinkingLevel: event.state.thinkingLevel ?? session.thinkingLevel,
      };
      const modelChanged = next.model !== session.model && !sameModel(next.model, session.model);
      if (modelChanged || next.thinkingLevel !== session.thinkingLevel) this.saveSession(next);
    }
  }

  private addPendingUi(sessionId: string, live: LiveSession, request: UiRequest): void {
    live.pendingUi.set(request.id, request);
    if (request.timeoutMs === undefined) return;
    // The agent auto-resolves timed-out dialogs without telling us; don't stay "blocked" forever.
    const timer = setTimeout(() => {
      live.uiTimers.delete(request.id);
      if (!live.pendingUi.delete(request.id) || this.live.get(sessionId) !== live) return;
      const session = this.store.getSession(sessionId);
      if (!session) return;
      this.emitSessionEvent(session, { type: "ui_request_closed", id: request.id });
      this.saveSession(session);
    }, request.timeoutMs);
    timer.unref();
    live.uiTimers.set(request.id, timer);
  }

  private removePendingUi(live: LiveSession, requestId: string): boolean {
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
    if (this.live.get(id) !== live) return;
    this.clearPendingUi(live);
    live.unsubscribe();
    this.live.delete(id);
    this.tokens.revoke(id);
    const wasRunning = live.running;
    const session = this.store.getSession(id);
    if (!session) return;
    const agent = this.agents.get(id);
    if (agent && !agent.closed) {
      this.clearAgentTimer(id);
      this.agents.update(id, { closed: true, closing: false });
      if (agent.doneAt === null) {
        this.deliver(agent.parentSessionId, exitedText(agent.name, "Process ended without calling report_done (crashed)."), "followUp");
      }
    }
    if (error) {
      this.options.log?.(`session ${id}: agent exited: ${error.message}`);
      this.emitSessionEvent(session, { type: "error", message: error.message });
    }
    if (error || wasRunning) {
      this.emitSessionEvent(session, { type: "state", state: { isRunning: false } });
      this.emitSessionEvent(session, { type: "run_end" });
      // A crash ends the run: flag it, and mark unread like any run that ends off screen.
      // Dying mid-run also means the work was cut off.
      const unread = session.unread || !this.viewers.has(id);
      const next: Session = { ...session, lastRunFailed: true, unread, runInProgress: false };
      if (wasRunning || session.runInProgress) next.interrupted = true;
      this.saveSession(next);
    } else {
      this.saveSession(session);
    }
  }

  private async closeLive(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    this.clearPendingUi(live);
    live.unsubscribe();
    this.live.delete(id);
    this.tokens.revoke(id);
    await live.session.dispose();
  }

  /** Keep at most `maxIdleProcesses` idle sessions alive (least recently used go first). */
  private evictIdle(keepId?: string): void {
    const max = this.store.getSettings().agent.maxIdleProcesses;
    const idle = [...this.live.entries()]
      .filter(([id, l]) => id !== keepId && !l.running && l.pendingUi.size === 0 && !this.viewers.has(id))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const excess = idle.length - max;
    for (let i = 0; i < excess; i++) void this.closeLive(idle[i]![0]);
  }

  async dispose(): Promise<void> {
    this.usage?.stop();
    for (const timer of this.agentTimers.values()) clearTimeout(timer);
    this.agentTimers.clear();
    this.agents.flush();
    await Promise.all([...this.live.keys()].map((id) => this.closeLive(id)));
    await this.harness.dispose();
    this.store.flush();
  }
}
