import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import {
  DEFAULT_IMAGE_LIMITS,
  applyAgentEvent,
  deriveChatStatus,
  quickTitle,
  sameModel,
  type AgentEvent,
  type Chat,
  type ChatDetail,
  type ChatSummary,
  type CompactResult,
  type CreateChatRequest,
  type CreateProjectRequest,
  type DeepPartial,
  type ModelInfo,
  type ModelRef,
  type OpenTarget,
  type Project,
  type PromptImage,
  type PromptRequest,
  type ServerMessage,
  type Settings,
  type SlashCommand,
  type ThinkingLevel,
  type Transcript,
  type UiRequest,
  type UiResponse,
  type UpdateChatRequest,
  type UpdateProjectRequest,
  type UsageLimits,
} from "@pi-ui/protocol";
import type { AgentHarness, HarnessSession } from "../harness/types.js";
import type { Store } from "../store/store.js";
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
    readonly status: 400 | 404 | 409 | 424 | 500 | 501,
    message: string,
  ) {
    super(message);
  }
}

interface LiveChat {
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
}

type Listener = (message: ServerMessage) => void;

/**
 * Owns projects, chats and the pool of live agent sessions. HTTP routes and the WebSocket are
 * thin layers over this class, which keeps it easy to test with the fake harness.
 */
export class AppService {
  private readonly live = new Map<string, LiveChat>();
  private readonly opening = new Map<string, Promise<LiveChat>>();
  private readonly listeners = new Set<Listener>();
  private readonly usage: UsageLimitsPoller | null;
  /** chatId -> number of clients currently viewing it. */
  private readonly viewers = new Map<string, number>();
  private readonly store: Store;
  private readonly harness: AgentHarness;
  /** Files written by `exportChat` this run; the only paths `revealPath` will show. */
  private readonly exported = new Set<string>();

  constructor(private readonly options: AppServiceOptions) {
    this.store = options.store;
    this.harness = options.harness;
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
    for (const chat of this.store.listChats()) {
      if (!chat.runInProgress) continue;
      this.saveChat({ ...chat, runInProgress: false, interrupted: true, unread: true, lastRunFailed: true });
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

  /** Track which chats are on screen, so finished runs there don't get marked unread. */
  setViewing(chatId: string, viewing: boolean): void {
    const count = (this.viewers.get(chatId) ?? 0) + (viewing ? 1 : -1);
    if (count <= 0) this.viewers.delete(chatId);
    else this.viewers.set(chatId, count);
    if (viewing) {
      const chat = this.store.getChat(chatId);
      if (chat?.unread) this.saveChat({ ...chat, unread: false });
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

  /** Removes the project and all of its chats (including their session files). */
  async deleteProject(id: string): Promise<void> {
    this.requireProject(id);
    for (const chat of this.store.listChats().filter((c) => c.projectId === id)) {
      await this.deleteChat(chat.id);
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
  // Chats
  // -------------------------------------------------------------------------------------------

  listChats(): ChatSummary[] {
    return this.store.listChats().map((c) => this.summarize(c));
  }

  private summarize(chat: Chat): ChatSummary {
    const live = this.live.get(chat.id);
    const running = live?.running ?? false;
    const pendingInputs = live?.pendingUi.size ?? 0;
    return { ...chat, running, pendingInputs, status: deriveChatStatus({ running, pendingInputs, unread: chat.unread }) };
  }

  private requireChat(id: string): Chat {
    const chat = this.store.getChat(id);
    if (!chat) throw new HttpError(404, "Chat not found");
    return chat;
  }

  private saveChat(chat: Chat): ChatSummary {
    this.store.upsertChat(chat);
    const summary = this.summarize(chat);
    this.broadcast({ type: "chat_upsert", chat: summary });
    return summary;
  }

  async createChat(req: CreateChatRequest): Promise<ChatDetail> {
    const project = req.projectId ? this.requireProject(req.projectId) : null;
    const settings = this.store.getSettings();
    const now = Date.now();
    const chat: Chat = {
      id: randomUUID(),
      projectId: project?.id ?? null,
      title: req.prompt ? quickTitle(req.prompt) : "New chat",
      titleSource: "auto",
      cwd: project?.path ?? this.options.scratchDir,
      harness: this.harness.id,
      sessionRef: null,
      pinned: false,
      unread: false,
      createdAt: now,
      lastActivityAt: now,
      model: req.model ?? settings.models.defaultModel,
      thinkingLevel: req.thinkingLevel ?? settings.models.defaultThinkingLevel,
    };
    this.saveChat(chat);
    try {
      const live = await this.ensureLive(chat.id);
      if (req.prompt?.trim() || req.images?.length) {
        await this.sendPrompt(chat.id, { text: req.prompt ?? "", images: req.images }, live);
      }
    } catch (err) {
      // Don't leave a broken, empty chat behind.
      await this.deleteChat(chat.id).catch(() => {});
      throw err;
    }
    return this.getChatDetail(chat.id);
  }

  async getChatDetail(id: string): Promise<ChatDetail> {
    this.requireChat(id);
    const live = await this.ensureLive(id);
    return {
      chat: this.summarize(this.requireChat(id)),
      transcript: live.transcript,
      state: live.session.getState(),
      pendingUiRequests: [...live.pendingUi.values()],
    };
  }

  async updateChat(id: string, req: UpdateChatRequest): Promise<ChatSummary> {
    const chat = this.requireChat(id);
    const next: Chat = { ...chat };
    if (req.title !== undefined) {
      const title = req.title.trim();
      if (!title) throw new HttpError(400, "Title cannot be empty");
      next.title = title;
      next.titleSource = "user";
      await this.live.get(id)?.session.setTitle(title).catch(() => {});
    }
    if (req.pinned === true && !chat.pinned) {
      // Newly pinned chats go to the top of their list's pinned group.
      const orders = this.pinnedChats(chat.projectId).map((c) => c.pinOrder ?? 0);
      next.pinned = true;
      next.pinOrder = orders.length ? Math.min(...orders) - 1 : 0;
    } else if (req.pinned === false) {
      next.pinned = false;
      delete next.pinOrder;
    }
    if (req.unread !== undefined) next.unread = req.unread;
    if (req.interrupted === false) delete next.interrupted;
    return this.saveChat(next);
  }

  /** Pinned chats of one list (a project, or standalone = null), in pin order. */
  private pinnedChats(projectId: string | null): Chat[] {
    return this.store
      .listChats()
      .filter((c) => c.pinned && c.projectId === projectId)
      .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0));
  }

  /** Reorder the pinned chats of one list. `ids` must be exactly that list's pinned chats. */
  reorderPinnedChats(projectId: string | null, ids: string[]): ChatSummary[] {
    if (projectId !== null) this.requireProject(projectId);
    if (!sameIdSet(ids, this.pinnedChats(projectId).map((c) => c.id))) {
      throw new HttpError(400, "ids must list every pinned chat of that list exactly once");
    }
    ids.forEach((id, pinOrder) => {
      const chat = this.store.getChat(id)!;
      if (chat.pinOrder !== pinOrder) this.saveChat({ ...chat, pinOrder });
    });
    return this.pinnedChats(projectId).map((c) => this.summarize(c));
  }

  async deleteChat(id: string): Promise<void> {
    const chat = this.requireChat(id);
    await this.closeLive(id);
    if (chat.sessionRef) await this.harness.deleteSession(chat.sessionRef).catch(() => {});
    this.store.removeChat(id);
    this.viewers.delete(id);
    this.broadcast({ type: "chat_removed", chatId: id });
  }

  async prompt(id: string, req: PromptRequest): Promise<void> {
    const live = await this.ensureLive(id);
    await this.sendPrompt(id, req, live);
  }

  private async sendPrompt(id: string, req: PromptRequest, live: LiveChat): Promise<void> {
    if (!req.text.trim() && !req.images?.length) throw new HttpError(400, "Message is empty");
    await this.checkImageSizes(req.images, live);
    const isFirst = !live.transcript.messages.some((m) => m.role === "user");
    live.lastUsedAt = Date.now();
    const behavior = req.behavior ?? this.store.getSettings().general.busyBehavior;
    await live.session.prompt({ ...req, behavior });
    const chat = this.requireChat(id);
    const updates: Partial<Chat> = { lastActivityAt: Date.now() };
    if (isFirst && chat.titleSource === "auto" && req.text.trim()) {
      updates.title = quickTitle(req.text);
      void this.generateTitle(id, req.text).catch((err: Error) => this.options.log?.(`title generation failed: ${err.message}`));
    }
    const next: Chat = { ...chat, ...updates };
    delete next.interrupted; // any new prompt dismisses the "interrupted" state
    this.saveChat(next);
    if (updates.title) await live.session.setTitle(updates.title).catch(() => {});
    this.touchProject(chat.projectId);
  }

  /**
   * Reject images over the model's size limit with a clear message instead of letting the
   * provider fail the run. Clients downscale before sending, so this is only a safety net.
   */
  private async checkImageSizes(images: PromptImage[] | undefined, live: LiveChat): Promise<void> {
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
    const chat = this.store.getChat(id);
    if (!chat) return;
    const title = await this.harness.generateTitle({
      firstMessage,
      cwd: chat.cwd,
      model: settings.models.titleModel ?? (await this.defaultTitleModel()) ?? chat.model,
    });
    const current = this.store.getChat(id);
    if (!title || !current || current.titleSource !== "auto") return;
    this.saveChat({ ...current, title });
    await this.live.get(id)?.session.setTitle(title).catch(() => {});
  }

  /** Titles use a cheap, fast model by default (Haiku) when it's available. */
  private async defaultTitleModel(): Promise<ModelRef | null> {
    const models = await this.harness.listModels().catch(() => [] as ModelInfo[]);
    return models.some((m) => sameModel(m, DEFAULT_TITLE_MODEL)) ? DEFAULT_TITLE_MODEL : null;
  }

  async abort(id: string): Promise<void> {
    const live = this.live.get(id);
    if (live) await live.session.abort();
  }

  async setModel(id: string, model: ModelRef): Promise<void> {
    const live = await this.ensureLive(id);
    await live.session.setModel(model);
  }

  async setThinkingLevel(id: string, level: ThinkingLevel): Promise<void> {
    const live = await this.ensureLive(id);
    await live.session.setThinkingLevel(level);
  }

  // -------------------------------------------------------------------------------------------
  // Slash-command support (pi-ui's own built-ins run in the web app; see docs/ARCHITECTURE.md)
  // -------------------------------------------------------------------------------------------

  /** The harness's slash commands (extensions, skills, prompt templates) for a chat. */
  async listCommands(id: string): Promise<SlashCommand[]> {
    const live = await this.ensureLive(id);
    return live.session.listCommands ? live.session.listCommands() : [];
  }

  async compact(id: string, instructions?: string): Promise<CompactResult> {
    const live = await this.ensureLive(id);
    if (!live.session.compact) throw new HttpError(409, "This agent can't compact its context");
    if (live.running) throw new HttpError(409, "Wait for the current reply to finish before compacting");
    if (live.session.getState().isCompacting) throw new HttpError(409, "Already compacting");
    live.lastUsedAt = Date.now();
    return live.session.compact(instructions?.trim() || undefined);
  }

  /** Export the chat to an HTML file; optionally reveal it in Finder. */
  async exportChat(id: string, options: { reveal?: boolean } = {}): Promise<{ path: string }> {
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
    const live = this.live.get(id);
    if (!live) throw new HttpError(404, "Chat is not running");
    live.session.respondToUi(response);
    const wasPending = this.removePendingUi(live, response.id);
    this.broadcast({ type: "chat_event", chatId: id, event: { type: "ui_request_closed", id: response.id } });
    const chat = this.store.getChat(id);
    if (wasPending && chat) this.saveChat(chat); // pendingInputs/status changed
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
  // Live session pool
  // -------------------------------------------------------------------------------------------

  /** Number of agent processes currently alive (for tests/diagnostics). */
  get liveCount(): number {
    return this.live.size;
  }

  private ensureLive(id: string): Promise<LiveChat> {
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

  private async openLive(id: string): Promise<LiveChat> {
    const chat = this.requireChat(id);
    mkdirSync(chat.cwd, { recursive: true });
    const session = await this.harness.openSession({
      cwd: chat.cwd,
      sessionRef: chat.sessionRef,
      model: chat.model,
      thinkingLevel: chat.thinkingLevel,
    });
    const transcript = await session.loadTranscript();
    const live: LiveChat = {
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
    const current = this.requireChat(id);
    if (current.sessionRef !== session.sessionRef || !current.model) {
      this.saveChat({
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

  private handleEvent(id: string, live: LiveChat, event: AgentEvent): void {
    live.transcript = applyAgentEvent(live.transcript, event);
    if (event.type === "run_start") live.running = true;
    if (event.type === "run_end") live.running = false;
    if (event.type === "ui_request") this.addPendingUi(id, live, event.request);
    if (event.type === "ui_request_closed") this.removePendingUi(live, event.id);

    this.broadcast({ type: "chat_event", chatId: id, event });

    const chat = this.store.getChat(id);
    if (!chat) return;
    if (event.type === "run_start") {
      const next: Chat = { ...chat, lastActivityAt: Date.now(), lastRunFailed: false, runInProgress: true };
      delete next.interrupted;
      this.saveChat(next);
    } else if (event.type === "run_end") {
      this.usage?.onRunEnd();
      this.clearPendingUi(live);
      live.lastUsedAt = Date.now();
      this.saveChat({ ...chat, lastActivityAt: Date.now(), runInProgress: false, unread: chat.unread || !this.viewers.has(id) });
      this.evictIdle();
    } else if (event.type === "ui_request" || event.type === "ui_request_closed") {
      this.saveChat(chat); // pendingInputs/status changed
    } else if (
      (event.type === "error" || (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error")) &&
      !chat.lastRunFailed
    ) {
      this.saveChat({ ...chat, lastRunFailed: true });
    } else if (event.type === "state" && (event.state.model || event.state.thinkingLevel)) {
      const next = {
        ...chat,
        model: event.state.model ?? chat.model,
        thinkingLevel: event.state.thinkingLevel ?? chat.thinkingLevel,
      };
      const modelChanged = next.model !== chat.model && !sameModel(next.model, chat.model);
      if (modelChanged || next.thinkingLevel !== chat.thinkingLevel) this.saveChat(next);
    }
  }

  private addPendingUi(chatId: string, live: LiveChat, request: UiRequest): void {
    live.pendingUi.set(request.id, request);
    if (request.timeoutMs === undefined) return;
    // The agent auto-resolves timed-out dialogs without telling us; don't stay "blocked" forever.
    const timer = setTimeout(() => {
      live.uiTimers.delete(request.id);
      if (!live.pendingUi.delete(request.id) || this.live.get(chatId) !== live) return;
      this.broadcast({ type: "chat_event", chatId, event: { type: "ui_request_closed", id: request.id } });
      const chat = this.store.getChat(chatId);
      if (chat) this.saveChat(chat);
    }, request.timeoutMs);
    timer.unref();
    live.uiTimers.set(request.id, timer);
  }

  private removePendingUi(live: LiveChat, requestId: string): boolean {
    const timer = live.uiTimers.get(requestId);
    if (timer) clearTimeout(timer);
    live.uiTimers.delete(requestId);
    return live.pendingUi.delete(requestId);
  }

  private clearPendingUi(live: LiveChat): void {
    for (const timer of live.uiTimers.values()) clearTimeout(timer);
    live.uiTimers.clear();
    live.pendingUi.clear();
  }

  private handleExit(id: string, live: LiveChat, error: Error | null): void {
    if (this.live.get(id) !== live) return;
    this.clearPendingUi(live);
    live.unsubscribe();
    this.live.delete(id);
    const wasRunning = live.running;
    if (error) {
      this.options.log?.(`chat ${id}: agent exited: ${error.message}`);
      this.broadcast({ type: "chat_event", chatId: id, event: { type: "error", message: error.message } });
    }
    if (error || wasRunning) {
      this.broadcast({ type: "chat_event", chatId: id, event: { type: "state", state: { isRunning: false } } });
      this.broadcast({ type: "chat_event", chatId: id, event: { type: "run_end" } });
    }
    const chat = this.store.getChat(id);
    if (!chat) return;
    if (error || wasRunning) {
      // A crash ends the run: flag it, and mark unread like any run that ends off screen.
      // Dying mid-run also means the work was cut off.
      const unread = chat.unread || !this.viewers.has(id);
      const next: Chat = { ...chat, lastRunFailed: true, unread, runInProgress: false };
      if (wasRunning || chat.runInProgress) next.interrupted = true;
      this.saveChat(next);
    } else {
      this.saveChat(chat);
    }
  }

  private async closeLive(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    this.clearPendingUi(live);
    live.unsubscribe();
    this.live.delete(id);
    await live.session.dispose();
  }

  /** Keep at most `maxIdleProcesses` idle sessions alive (least recently used go first). */
  private evictIdle(keepId?: string): void {
    const max = this.store.getSettings().agent.maxIdleProcesses;
    const idle = [...this.live.entries()]
      .filter(
        ([id, l]) => id !== keepId && !l.running && l.pendingUi.size === 0 && !this.viewers.has(id),
      )
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const excess = idle.length - max;
    for (let i = 0; i < excess; i++) void this.closeLive(idle[i]![0]);
  }

  async dispose(): Promise<void> {
    this.usage?.stop();
    await Promise.all([...this.live.keys()].map((id) => this.closeLive(id)));
    await this.harness.dispose();
    this.store.flush();
  }
}
