/**
 * What the user does inside a running chat: prompts (with image checks and the first-message
 * title), abort, `!` shell commands (I-076), model/thinking changes, slash-command support
 * (commands, compact, export), dialogs answered in the UI, and attachments (I-090).
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_IMAGE_LIMITS,
  parseAttachedFiles,
  quickTitle,
  sameModel,
  type AttachmentUploadResponse,
  type CompactResult,
  type ModelInfo,
  type ModelRef,
  type PromptImage,
  type PromptRequest,
  type Session,
  type ShellRequest,
  type ShellResponse,
  type SlashCommand,
  type ThinkingLevel,
  type UiResponse,
} from "@glade/protocol";
import { createRevealPath } from "../reveal.js";
import type { AppContext, LiveSession } from "./context.js";
import { ActiveElsewhereError, HttpError } from "./errors.js";
import type { LeaseSync } from "./lease-sync.js";
import type { LivePool } from "./live-pool.js";
import type { Records } from "./records.js";
import type { Titles } from "./titles.js";

/** Byte size of base64 data once decoded (ignores whitespace and padding). */
export function decodedBase64Size(data: string): number {
  const clean = data.replace(/\s/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

function formatMB(bytes: number): string {
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

export class SessionActions {
  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
    private readonly pool: LivePool,
    private readonly leaseSync: LeaseSync,
    private readonly titles: Titles,
  ) {}

  /** Save a file attached by reference (I-090) for session `id`; its path goes into the prompt. */
  async saveAttachment(id: string, name: string, body: ReadableStream<Uint8Array> | null): Promise<AttachmentUploadResponse> {
    this.records.requireSession(id);
    return this.ctx.attachments.save(id, name, body);
  }

  /** A prompt from the user (the HTTP API). */
  async prompt(id: string, req: PromptRequest): Promise<void> {
    this.records.requireSession(id);
    this.leaseSync.assertNotBusyElsewhere(id);
    // Typing in a sub-agent's tab means the user is using it: never close it automatically.
    const agent = this.ctx.agents.get(id);
    if (agent && (!agent.userEngaged || agent.closed || agent.closing)) {
      this.ctx.agentTimers.clear(id);
      this.records.updateAgent(id, { userEngaged: true, closed: false, closing: false });
    }
    const live = await this.pool.ensureLive(id);
    await this.sendPrompt(id, req, live);
  }

  async sendPrompt(id: string, req: PromptRequest, live: LiveSession): Promise<void> {
    if (!req.text.trim() && !req.images?.length) throw new HttpError(400, "Message is empty");
    await this.checkImageSizes(req.images, live);
    const isFirst = !live.transcript.messages.some((m) => m.role === "user");
    live.lastUsedAt = Date.now();
    live.lastPromptAt = Date.now();
    live.awaitingRun = true;
    const behavior = req.behavior ?? this.ctx.store.getSettings().general.busyBehavior;
    await live.session.prompt({ ...req, behavior });
    const session = this.records.requireSession(id);
    const next: Session = { ...session, lastActivityAt: Date.now() };
    delete next.interrupted; // any new prompt dismisses the "interrupted" state
    // Titles come from what the user typed, not the `Attached file:` lines (I-090).
    const typed = parseAttachedFiles(req.text).text;
    const retitle = isFirst && session.titleSource === "auto" && !!typed.trim();
    if (retitle) {
      next.title = quickTitle(typed);
      void this.titles.generateTitle(id, typed).catch((err: Error) => this.ctx.options.log?.(`title generation failed: ${err.message}`));
    }
    this.records.saveSession(next, { touch: true });
    if (retitle) {
      this.titles.followTitle(next);
      await live.session.setTitle(next.title).catch(() => {});
    }
    this.records.touchProject(this.ctx.store.getWorkspace(session.workspaceId)?.projectId ?? null);
  }

  /**
   * Reject images over the model's size limit with a clear message instead of letting the
   * provider fail the run. Clients downscale before sending, so this is only a safety net.
   */
  private async checkImageSizes(images: PromptImage[] | undefined, live: LiveSession): Promise<void> {
    if (!images?.length) return;
    const model = live.session.getState().model;
    const models = model ? await live.harness.listModels().catch(() => [] as ModelInfo[]) : [];
    const limits = models.find((m) => sameModel(m, model))?.imageLimits ?? DEFAULT_IMAGE_LIMITS;
    images.forEach((image, i) => {
      const bytes = decodedBase64Size(image.data);
      if (bytes > limits.maxBytes) {
        const which = images.length > 1 ? `Image ${i + 1}` : "The image";
        throw new HttpError(400, `${which} is too large (${formatMB(bytes)}); this model accepts images up to ${formatMB(limits.maxBytes)}`);
      }
    });
  }

  async abort(id: string): Promise<void> {
    this.records.requireSession(id);
    const live = this.ctx.live.get(id);
    if (live) return live.session.abort();
    const elsewhere = this.ctx.leases?.foreignLeaseNow(id);
    if (elsewhere && (elsewhere.running || elsewhere.pendingInputs > 0)) throw new ActiveElsewhereError(elsewhere);
  }

  /**
   * `!cmd` / `!!cmd` (I-076): run a shell command in the session's folder. Answers once it has
   * started; output and the result arrive as `shell_*` events. Allowed while the agent runs.
   */
  async runShell(id: string, req: ShellRequest): Promise<ShellResponse> {
    const command = req.command.trim();
    if (!command) throw new HttpError(400, "command is empty");
    const record = this.records.requireSession(id);
    const harness = this.records.requireHarness(record);
    if (!harness.info.capabilities.shell) throw new HttpError(501, `${harness.info.label} can't run shell commands`);
    this.leaseSync.assertNotBusyElsewhere(id);
    const live = await this.pool.ensureLive(id);
    if (!live.session.runShell) throw new HttpError(501, `${harness.info.label} can't run shell commands`);
    const shellId = `shell-${randomUUID()}`;
    live.lastUsedAt = Date.now();
    void live.session
      .runShell({ id: shellId, command, shareWithAgent: req.shareWithAgent })
      .catch((err: Error) => this.ctx.options.log?.(`shell command failed: ${err.message}`));
    return { id: shellId };
  }

  /** Stop the session's running shell command(s) (I-076). */
  async abortShell(id: string): Promise<void> {
    this.records.requireSession(id);
    const live = this.ctx.live.get(id);
    if (!live) return;
    if (!live.session.abortShell) throw new HttpError(501, `${live.harness.info.label} can't run shell commands`);
    await live.session.abortShell();
  }

  async setModel(id: string, model: ModelRef): Promise<void> {
    this.records.requireSession(id);
    const live = await this.pool.ensureLive(id);
    await live.session.setModel(model);
  }

  async setThinkingLevel(id: string, level: ThinkingLevel): Promise<void> {
    this.records.requireSession(id);
    const live = await this.pool.ensureLive(id);
    await live.session.setThinkingLevel(level);
  }

  // Slash-command support (Glade's own built-ins run in the web app; see docs/ARCHITECTURE.md)

  /** The harness's slash commands (extensions, skills, prompt templates) for a session. */
  async listCommands(id: string): Promise<SlashCommand[]> {
    const session = this.records.requireSession(id);
    const harness = this.records.requireHarness(session);
    if ((this.records.isDormantAgent(id) || this.leaseSync.isElsewhere(id)) && harness.listFolderCommands) {
      // Don't start a closed sub-agent just for its slash menu; its folder's commands are the same.
      const workspace = this.records.requireWorkspace(session.workspaceId);
      return harness.listFolderCommands(workspace.cwd);
    }
    const live = await this.pool.ensureLive(id);
    return live.session.listCommands ? live.session.listCommands() : [];
  }

  async compact(id: string, instructions?: string): Promise<CompactResult> {
    this.records.requireSession(id);
    const live = await this.pool.ensureLive(id);
    if (!live.session.compact) throw new HttpError(409, "This agent can't compact its context");
    if (live.running) throw new HttpError(409, "Wait for the current reply to finish before compacting");
    if (live.session.getState().isCompacting) throw new HttpError(409, "Already compacting");
    live.lastUsedAt = Date.now();
    return live.session.compact(instructions?.trim() || undefined);
  }

  /** Export the session to an HTML file; optionally reveal it in Finder. */
  async exportSession(id: string, options: { reveal?: boolean } = {}): Promise<{ path: string }> {
    this.records.requireSession(id);
    const live = await this.pool.ensureLive(id);
    if (!live.session.exportHtml) throw new HttpError(409, "This agent can't export chats");
    const path = await live.session.exportHtml();
    this.ctx.exported.add(path);
    if (options.reveal) await this.revealPath(path);
    return { path };
  }

  /** Reveal a file this server exported (arbitrary paths are refused). */
  async revealPath(path: string): Promise<void> {
    // Exported files, and files attached by reference (I-090).
    if (!this.ctx.exported.has(path) && !(await this.ctx.attachments.isAttachment(path))) throw new HttpError(404, "Unknown file");
    await (this.ctx.options.revealPath ?? createRevealPath())(path);
  }

  respondToUi(id: string, response: UiResponse): void {
    const session = this.records.requireSession(id);
    const live = this.ctx.live.get(id);
    if (!live) throw new HttpError(404, "Session is not running");
    live.session.respondToUi(response);
    const wasPending = this.pool.removePendingUi(live, response.id);
    this.records.emitSessionEvent(session, { type: "ui_request_closed", id: response.id });
    if (wasPending) this.records.saveSession(session); // pendingInputs/status changed
  }
}
