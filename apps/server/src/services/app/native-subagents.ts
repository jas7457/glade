/**
 * The harness's own sub-agents (I-188): Claude Code's Task/Agent tool, Codex's `spawn_agent`.
 * A harness session announces them with `native_subagent_*` events (`harness/types.ts`); each
 * becomes a read-only `subagent` session of the parent, shown like Glade's own sub-agents (tab,
 * card, status, report) and stored like any conversation.
 *
 * - **No process of its own.** Its `LiveSession` wraps a {@link NativeSubagentSession} that only
 *   mirrors state; its events are folded by the live pool like any harness's (`LivePool.inject`),
 *   so transcripts, the store, pushes, unread and status all work unchanged. It holds a lease
 *   while it runs (other servers on the data folder show it as running elsewhere).
 * - **Running from start to end.** The server owns its run: `run_start` + its task as the first
 *   message at start, `run_end` at the end. Its agent record (`native`: the harness's label) is
 *   `closed` once it ended; `doneAt` + `result` when it finished (status "done").
 * - **Read-only.** Prompts are refused (409); it's never started again after it ended or after a
 *   restart (viewing it reads the store). The agent API (list/message/close_agent) doesn't see it.
 * - **Lifetime.** It ends when the harness says so, or as stopped when the parent's process stops
 *   or exits. Closing its tab deletes it (the parent isn't told: it's the harness's agent).
 */
import { randomUUID } from "node:crypto";
import {
  defaultSessionState,
  quickTitle,
  type AgentEvent,
  type ModelRef,
  type Session,
  type SessionState,
  type Transcript,
} from "@glade/protocol";
import type { HarnessSession, NativeSubagentEvent } from "../../harness/types.js";
import { pickAgentIdentity } from "../agent-names.js";
import { normalizeAgentName } from "../agents.js";
import type { AppContext, LiveSession } from "./context.js";
import type { Records } from "./records.js";
import { MessageIds, TranscriptWriter } from "./transcript-writer.js";

/** What the module needs from the live pool. */
export interface NativeSubagentPool {
  /** Fold an event into a live session (transcript, store, clients). */
  inject(sessionId: string, event: AgentEvent): boolean;
}

interface NativeChild {
  sessionId: string;
  ended: boolean;
}

/** Why typing in a native sub-agent's tab is refused. */
export function nativeReadOnlyMessage(label: string): string {
  return `This is ${label}'s own sub-agent: Glade shows its work, but it can't be messaged.`;
}

export class NativeSubagents {
  /** Parent session id → native id → child. */
  private readonly byParent = new Map<string, Map<string, NativeChild>>();

  constructor(
    private readonly ctx: AppContext,
    private readonly records: Records,
    private readonly pool: NativeSubagentPool,
  ) {}

  handle(parentId: string, event: NativeSubagentEvent): void {
    try {
      switch (event.type) {
        case "native_subagent_start":
          this.start(parentId, event);
          return;
        case "native_subagent_event":
          this.event(parentId, event.id, event.event);
          return;
        case "native_subagent_end":
          this.end(parentId, event.id, event.status, event.result);
          return;
      }
    } catch (err) {
      this.ctx.options.log?.(`session ${parentId}: native sub-agent ${event.id}: ${(err as Error).message}`);
    }
  }

  /** Native sub-agents of this parent still running (the parent isn't evicted meanwhile). */
  hasRunning(parentId: string): boolean {
    return [...(this.byParent.get(parentId)?.values() ?? [])].some((c) => !c.ended);
  }

  /** The parent's process stopped or exited: its native sub-agents can't go on. */
  endAll(parentId: string, reason = "Stopped with its parent"): void {
    const children = this.byParent.get(parentId);
    if (!children) return;
    for (const [id, child] of children) if (!child.ended) this.end(parentId, id, "stopped", reason);
    this.byParent.delete(parentId);
  }

  private childrenOf(parentId: string): Map<string, NativeChild> {
    let children = this.byParent.get(parentId);
    if (!children) this.byParent.set(parentId, (children = new Map()));
    return children;
  }

  private start(parentId: string, event: Extract<NativeSubagentEvent, { type: "native_subagent_start" }>): void {
    const { ctx, records } = this;
    const children = this.childrenOf(parentId);
    if (children.has(event.id)) return;
    const parent = ctx.store.getSession(parentId);
    if (!parent) return;
    const label = ctx.harnesses.get(parent.harness)?.info.label ?? parent.harness;
    const now = Date.now();
    const name = normalizeAgentName(event.name) || "agent";
    const picked = pickAgentIdentity(
      ctx.agents.activeIn(parent.workspaceId),
      ctx.agents.childrenOf(parentId).map((r) => r.displayName),
    );
    const displayName = event.displayName?.trim() || picked.displayName;
    const task = event.task.trim();
    const title = event.title?.trim() || (task ? quickTitle(task) : "") || name;
    const session: Session = {
      id: randomUUID(),
      workspaceId: parent.workspaceId,
      kind: "subagent",
      parentSessionId: parentId,
      agentName: name,
      agentDisplayName: displayName,
      agentColor: picked.color,
      title,
      titleSource: "user",
      harness: parent.harness,
      sessionRef: null,
      unread: false,
      createdAt: now,
      lastActivityAt: now,
      model: event.model ?? parent.model,
      thinkingLevel: null,
    };
    children.set(event.id, { sessionId: session.id, ended: false });
    ctx.agents.upsert({
      sessionId: session.id,
      parentSessionId: parentId,
      workspaceId: parent.workspaceId,
      name,
      displayName,
      color: picked.color,
      agent: null,
      task,
      systemPrompt: "",
      tools: null,
      autoClose: false,
      keepOpenReason: null,
      userEngaged: false,
      spawnedAt: now,
      doneAt: null,
      result: null,
      closing: false,
      closed: false,
      native: label,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    });
    records.saveSession(session);
    records.pushSessions([parentId]); // its spawnedAgents changed

    const stored: Transcript = ctx.store.importTranscript(session.id, { messages: [], toolResults: {} }, { source: "live", sig: null }).transcript;
    const live: LiveSession = {
      harness: records.requireHarness(parent),
      session: new NativeSubagentSession(
        () => this.stateOf(session.id),
        () => this.ctx.live.get(parentId)?.session.stopNativeSubagent?.(event.id) ?? Promise.resolve(),
      ),
      transcript: stored,
      pendingUi: new Map(),
      uiTimers: new Map(),
      running: false,
      runStartedAt: null,
      lastUsedAt: now,
      lastPromptAt: 0,
      awaitingRun: false,
      shells: new Set(),
      sideQuestions: new Set(),
      ids: new MessageIds(),
      writer: new TranscriptWriter(ctx.store, session.id, stored, 250, ctx.options.log),
      unsubscribe: () => {},
      nativeParentId: parentId,
    };
    ctx.live.set(session.id, live);
    ctx.leases?.claim(session.id, { running: true, pendingInputs: 0 });
    this.pool.inject(session.id, { type: "run_start" });
    this.pool.inject(session.id, { type: "state", state: { isRunning: true } });
    if (task) {
      const message = { id: `native-task-${event.id}`, role: "user" as const, content: [{ type: "text" as const, text: task }], timestamp: now };
      this.pool.inject(session.id, { type: "message_start", message });
      this.pool.inject(session.id, { type: "message_end", message });
    }
  }

  private event(parentId: string, id: string, event: AgentEvent): void {
    // The server owns its run; dialogs are the parent's (its permission cards).
    if (event.type === "run_start" || event.type === "run_end" || event.type === "ui_request" || event.type === "ui_request_closed") return;
    let child = this.byParent.get(parentId)?.get(id);
    if (!child) {
      this.start(parentId, { type: "native_subagent_start", id, name: "agent", task: "" });
      child = this.byParent.get(parentId)?.get(id);
    }
    if (!child || child.ended) return;
    this.pool.inject(child.sessionId, event);
  }

  private end(parentId: string, id: string, status: "done" | "error" | "stopped", result?: string): void {
    const { ctx, records } = this;
    const child = this.byParent.get(parentId)?.get(id);
    if (!child || child.ended) return;
    child.ended = true;
    const sessionId = child.sessionId;
    const live = ctx.live.get(sessionId);
    if (live?.nativeParentId === parentId) {
      this.pool.inject(sessionId, { type: "state", state: { isRunning: false } });
      if (live.running) this.pool.inject(sessionId, { type: "run_end" });
      live.writer.flush();
      live.writer.close();
      if (ctx.live.get(sessionId) === live) ctx.live.delete(sessionId);
      ctx.leases?.release(sessionId);
    }
    const text = result?.trim() || null;
    ctx.agents.update(sessionId, {
      closed: true,
      closing: false,
      doneAt: status === "done" ? Date.now() : null,
      result: text,
    });
    const session = ctx.store.getSession(sessionId);
    if (session) {
      const next: Session = { ...session, runInProgress: false };
      if (status === "error") next.lastRunFailed = true;
      records.saveSession(next);
    }
    records.pushSessions([parentId]);
  }

  private stateOf(sessionId: string): SessionState {
    const session = this.ctx.store.getSession(sessionId);
    const live = this.ctx.live.get(sessionId);
    return { ...defaultSessionState(), model: session?.model ?? null, isRunning: live?.running ?? false };
  }
}

/**
 * The `HarnessSession` of a native sub-agent's `LiveSession`: nothing runs behind it. Its state is
 * the mirror's; prompts are refused (the parent's harness runs it).
 */
export class NativeSubagentSession implements HarnessSession {
  readonly sessionRef = null;

  constructor(
    private readonly state: () => SessionState,
    /** Stop asks the parent's harness to stop this sub-agent. */
    private readonly stop: () => Promise<void>,
  ) {}

  getState(): SessionState {
    return this.state();
  }

  async loadTranscript(): Promise<Transcript> {
    return { messages: [], toolResults: {} };
  }

  async prompt(): Promise<void> {
    throw new Error("A native sub-agent can't be messaged");
  }

  abort(): Promise<void> {
    return this.stop();
  }

  async setModel(_model: ModelRef): Promise<void> {}

  async setThinkingLevel(): Promise<void> {}

  async setTitle(): Promise<void> {}

  respondToUi(): void {}

  onEvent(): () => void {
    return () => {};
  }

  onExit(): () => void {
    return () => {};
  }

  async dispose(): Promise<void> {}
}
