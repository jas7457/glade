/**
 * Side questions (`/btw`, Ask Aside; I-140): a one-off answer over the chat's context, while the
 * agent keeps working. A follow-up (`parentId`, I-156) is asked in an existing card: its earlier
 * questions and answers go with the chat, and it's appended to the card's `followUps`. The prompt is built from Glade's own transcript (the live one, so a turn in
 * progress is included; `buildSideQuestionPrompt`) and answered by the harness's
 * `answerSideQuestion` (pi: a throwaway `pi -p` without tools or session). The chat's own agent
 * process is never sent anything.
 *
 * The card is a `SideQuestionMessage`, driven by `side_*` events that go through the live pool like
 * harness events (`LivePool.inject`): folded, pushed and written to Glade's store. Harness session
 * files never contain it, so the agent never sees it (imports keep it: `mergeTranscripts`). If the
 * chat's process stops meanwhile, the answer keeps streaming to clients and its final state is
 * written straight to the store.
 */
import { randomUUID } from "node:crypto";
import {
  SIDE_QUESTION_SYSTEM_PROMPT,
  agentModelSettings,
  applyAgentEvent,
  modelKey,
  sameModel,
  sideQuestionPrompt,
  sideQuestionStreaming,
  type AgentEvent,
  type ModelInfo,
  type ModelRef,
  type SideQuestionRequest,
  type SideQuestionResponse,
} from "@glade/protocol";
import type { AgentHarness } from "../../harness/types.js";
import type { AppContext } from "./context.js";
import { HttpError } from "./errors.js";
import type { LeaseSync } from "./lease-sync.js";
import type { LivePool } from "./live-pool.js";
import type { Records } from "./records.js";

/** Longest question accepted (characters). */
const MAX_QUESTION_CHARS = 20_000;

export class SideQuestions {
  /** Running side questions: `sessionId:questionId` -> stop, and the card it's in. */
  private readonly running = new Map<string, { controller: AbortController; sessionId: string; cardId: string }>();

  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
    private readonly pool: LivePool,
    private readonly leaseSync: LeaseSync,
  ) {}

  /** Ask a side question; answers once it started (the answer arrives as `side_*` events). */
  async ask(id: string, req: SideQuestionRequest): Promise<SideQuestionResponse> {
    const question = req.question.trim();
    if (!question) throw new HttpError(400, "question is empty");
    if (question.length > MAX_QUESTION_CHARS) throw new HttpError(400, "question is too long");
    const record = this.records.requireSession(id);
    const harness = this.records.requireHarness(record);
    if (!harness.info.capabilities.sideQuestions || !harness.answerSideQuestion) {
      throw new HttpError(501, `${harness.info.label} can't answer side questions`);
    }
    this.leaseSync.assertNotBusyElsewhere(id);
    const live = await this.pool.ensureLive(id);
    const workspace = this.records.requireWorkspace(record.workspaceId);
    const model = (await this.availableModel(harness, agentModelSettings(this.ctx.store.getSettings(), harness.id).sideQuestionModel)) ?? live.session.getState().model ?? record.model;
    const parentId = req.parentId || undefined;
    if (parentId) {
      const parent = live.transcript.messages.find((m) => m.id === parentId);
      if (parent?.role !== "side" || parent.dismissed) throw new HttpError(404, "side question not found");
      if (sideQuestionStreaming(parent)) throw new HttpError(409, "the side question is still being answered");
    }
    const { prompt, partial } = sideQuestionPrompt(live.transcript, question, parentId ? { threadId: parentId } : {});
    const qid = `side-${randomUUID()}`;
    const controller = new AbortController();
    const key = `${id}:${qid}`;
    this.running.set(key, { controller, sessionId: id, cardId: parentId ?? qid });
    live.lastUsedAt = Date.now();
    this.emit(id, {
      type: "side_start",
      id: qid,
      question,
      ...(model ? { model: modelKey(model) } : {}),
      ...(parentId ? { parentId } : {}),
      ...(partial ? { partialContext: true } : {}),
    });
    void harness
      .answerSideQuestion({
        prompt,
        systemPrompt: SIDE_QUESTION_SYSTEM_PROMPT,
        model,
        cwd: workspace.cwd,
        signal: controller.signal,
        onDelta: (delta) => {
          if (!controller.signal.aborted) this.emit(id, { type: "side_delta", id: qid, delta });
        },
      })
      .catch((err: Error) => ({ answer: "", error: err.message }))
      .then((result) => {
        this.running.delete(key);
        const stopped = controller.signal.aborted;
        if (result.error && !stopped) this.ctx.options.log?.(`session ${id}: side question failed: ${result.error}`);
        this.emit(id, {
          type: "side_end",
          id: qid,
          status: stopped ? "stopped" : result.error ? "error" : "done",
          answer: result.answer,
          ...(result.error && !stopped ? { error: result.error } : {}),
        });
      });
    return { id: qid };
  }

  /** Stop a side question that's still being answered (a no-op once it's done). */
  stop(id: string, qid: string): void {
    this.records.requireSession(id);
    this.running.get(`${id}:${qid}`)?.controller.abort();
  }

  /** Hide a side question's card (stopping its questions first if any is still running). */
  dismiss(id: string, qid: string): void {
    this.stop(id, qid);
    for (const [key, run] of this.running) if (run.sessionId === id && run.cardId === qid) this.stop(id, key.slice(id.length + 1));
    this.emit(id, { type: "side_dismiss", id: qid });
  }

  /** Whether a side question of this session is still being answered (tests). */
  isRunning(id: string, qid: string): boolean {
    return this.running.has(`${id}:${qid}`);
  }

  /**
   * Through the live process's pipeline when there is one (transcript, store, clients); otherwise
   * to clients, and ends/dismissals straight into the store.
   */
  private emit(id: string, event: AgentEvent): void {
    if (this.pool.inject(id, event)) return;
    const session = this.ctx.store.getSession(id);
    if (!session) return;
    const stamped = (event.type === "side_start" || event.type === "side_end") && event.at === undefined ? { ...event, at: Date.now() } : event;
    this.records.emitSessionEvent(session, stamped);
    if (stamped.type === "side_delta" || this.ctx.store.isClosed) return;
    const stored = this.ctx.store.loadTranscript(id);
    const next = applyAgentEvent(stored, stamped);
    const seq = next.messages.findIndex((m, i) => m !== stored.messages[i]);
    if (seq === -1) return;
    this.ctx.store.saveTranscriptChanges(id, [{ message: next.messages[seq]!, seq }], [], { pushed: false });
  }

  private async availableModel(harness: AgentHarness, model: ModelRef | null): Promise<ModelRef | null> {
    if (!model) return null;
    const models = await harness.listModels().catch(() => [] as ModelInfo[]);
    return models.some((m) => sameModel(m, model)) ? model : null;
  }
}
