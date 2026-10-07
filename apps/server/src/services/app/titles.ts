/**
 * Chat titles: the small-model title after a chat's first message, `/name` without a title
 * (I-074), and `auto` workspace titles following their first main session.
 */
import {
  firstMainSession,
  messageText as transcriptText,
  parseAgentMessage,
  type GenerateTitleResponse,
  type Session,
  type Transcript,
  type UpdateWorkspaceRequest,
  type WorkspaceSummary,
} from "@glade/protocol";
import { conversationExcerpt } from "../../harness/title.js";
import type { AgentHarness } from "../../harness/types.js";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";
import { quickTitle, quickTitleRunner, type QuickTaskRunner } from "./quick-tasks.js";
import type { Records } from "./records.js";
import type { Transcripts } from "./transcripts.js";

/** Default small model when no quick-tasks model is set (used only if available). */
export { DEFAULT_SMALL_MODEL } from "./quick-tasks.js";

/** What titles need from the workspaces module, wired by `AppService`. */
export interface TitlesHooks {
  updateWorkspace(id: string, req: UpdateWorkspaceRequest): Promise<WorkspaceSummary>;
}

export class Titles {
  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
    private readonly transcripts: Transcripts,
    private readonly hooks: TitlesHooks,
  ) {}

  /** An `auto` workspace title follows the title of its first main session. */
  followTitle(session: Session): void {
    const workspace = this.ctx.store.getWorkspace(session.workspaceId);
    if (!workspace || workspace.titleSource !== "auto" || workspace.title === session.title) return;
    if (firstMainSession(this.ctx.store.listSessions(workspace.id), workspace.id)?.id !== session.id) return;
    this.records.saveWorkspace({ ...workspace, title: session.title });
  }

  async generateTitle(id: string, firstMessage: string): Promise<void> {
    const settings = this.ctx.store.getSettings();
    const session = this.ctx.store.getSession(id);
    if (!settings.general.generateTitles || !session) return;
    // A sub-agent's report/message isn't the user's words (I-100).
    if (parseAgentMessage(firstMessage)) return;
    const workspace = this.ctx.store.getWorkspace(session.workspaceId);
    if (!workspace) return;
    // The quick-tasks agent writes it (I-198), else the chat's own harness.
    const runner = await this.runnerFor(session);
    if (!runner) return;
    const title = await quickTitle(runner, { firstMessage, cwd: workspace.cwd });
    const current = this.ctx.store.getSession(id);
    if (!title || !current || current.titleSource !== "auto") return;
    const next = { ...current, title };
    this.records.saveSession(next);
    this.followTitle(next);
    await this.ctx.live.get(id)?.session.setTitle(title).catch(() => {});
  }

  /**
   * A spawned sub-agent's short title from its task (I-148), with the chats' generator and
   * "Generate titles" setting. Stored as its session title with `titleSource: "auto"` (the tab
   * and chip show it next to the fun name); skipped when the user renamed it meanwhile.
   */
  async generateAgentTitle(id: string, task: string): Promise<void> {
    const settings = this.ctx.store.getSettings();
    const session = this.ctx.store.getSession(id);
    if (!settings.general.generateTitles || !session) return;
    const workspace = this.ctx.store.getWorkspace(session.workspaceId);
    if (!workspace) return;
    const runner = await this.runnerFor(session);
    if (!runner) return;
    const title = await quickTitle(runner, { firstMessage: task, cwd: workspace.cwd });
    const current = this.ctx.store.getSession(id);
    if (!title || !current || current.titleSource !== "user" || current.title !== current.agentName) return;
    this.records.saveSession({ ...current, title, titleSource: "auto" });
    await this.ctx.live.get(id)?.session.setTitle(title).catch(() => {});
  }

  /**
   * `/name` without a title (I-074): name the session from its conversation (first user message +
   * the latest few texts) with the small model, applied like a rename (`titleSource: "user"`;
   * while it's the workspace's only main tab the workspace is renamed with it).
   */
  async generateSessionTitle(id: string): Promise<GenerateTitleResponse> {
    const session = this.records.requireSession(id);
    const harness = this.records.requireHarness(session);
    const runner = await this.runnerFor(session);
    if (!runner) throw new HttpError(501, `${harness.info.label} can't generate titles`);
    const workspace = this.records.requireWorkspace(session.workspaceId);
    const messages = await this.conversationText(session, harness);
    const excerpt = conversationExcerpt(messages);
    const firstMessage = messages.find((m) => m.role === "user" && m.text.trim() && !parseAgentMessage(m.text))?.text;
    if (!excerpt || !firstMessage) throw new HttpError(409, "Nothing to name yet: this chat has no messages");
    const title = await quickTitle(runner, { firstMessage, excerpt, cwd: workspace.cwd });
    if (!title) throw new HttpError(500, "The model didn't come up with a title");
    const current = this.records.requireSession(id);
    const mainTabs = this.ctx.store.listSessions(current.workspaceId).filter((s) => s.kind === "main");
    if (current.kind === "main" && mainTabs.length <= 1) await this.hooks.updateWorkspace(current.workspaceId, { title });
    else await this.records.renameSession(current, title);
    return { title, session: this.records.summarizeSession(this.records.requireSession(id)) };
  }

  /** The user/assistant texts of a session: live transcript, else the store's copy (I-121). */
  private async conversationText(session: Session, _harness: AgentHarness): Promise<Array<{ role: "user" | "assistant"; text: string }>> {
    const fromTranscript = (t: Transcript) =>
      t.messages.flatMap((m) => (m.role === "user" || m.role === "assistant" ? [{ role: m.role, text: transcriptText(m) }] : []));
    const live = this.ctx.live.get(session.id);
    if (live) return fromTranscript(live.transcript);
    return this.transcripts.text(session);
  }

  /**
   * Who titles a session (titles, `/name`; I-074, I-198): the quick-tasks agent and model, else
   * the session's own harness with Haiku when it lists it, else the session's model.
   */
  private runnerFor(session: Session): Promise<QuickTaskRunner | null> {
    return quickTitleRunner(this.ctx.store.getSettings(), this.ctx.harnesses, { harness: this.ctx.harnesses.get(session.harness), model: session.model });
  }
}
