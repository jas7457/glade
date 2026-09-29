/**
 * Writing live conversations to the store (I-121), at the one choke point every harness passes
 * through (`LivePool.handleEvent`):
 *
 * - {@link MessageIds} gives each message a stable Glade id (a ULID) when it starts, and rewrites
 *   the harness's ids (pi's positional `m<n>`, ACP's per-process ones) in every event before it's
 *   folded and pushed, so clients, the store and later reloads all see the same id.
 * - {@link TranscriptWriter} writes what changed: streaming updates at most every ~250 ms per
 *   session, and at once when a message, tool, shell command or run ends. Changes are found by
 *   object identity (the reducer keeps unchanged messages as they were).
 */
import type { AgentEvent, ChatMessage, ToolResult, Transcript } from "@glade/protocol";
import { ulid } from "../../store/db/ids.js";
import type { Store } from "../../store/store.js";

/** Harness message id -> Glade id, for one live process. */
export class MessageIds {
  private readonly map = new Map<string, string>();

  /** Glade id for a harness id, created on first sight (`message_start`, or a lone `message_end`). */
  private idFor(harnessId: string): string {
    let id = this.map.get(harnessId);
    if (!id) this.map.set(harnessId, (id = ulid()));
    return id;
  }

  rewrite(event: AgentEvent): AgentEvent {
    switch (event.type) {
      case "message_start":
      case "message_end":
        // Shell messages already carry Glade's own id (chosen by `runShell`).
        if (event.message.role === "shell") return event;
        return { ...event, message: { ...event.message, id: this.idFor(event.message.id) } };
      case "block_start":
      case "block_delta":
      case "block_end": {
        const id = this.map.get(event.messageId);
        return id ? { ...event, messageId: id } : event;
      }
      default:
        return event;
    }
  }
}

/** Events after which the store is written at once (not coalesced). */
export function isFlushPoint(event: AgentEvent): boolean {
  return (
    event.type === "message_end" ||
    event.type === "run_end" ||
    event.type === "tool_end" ||
    event.type === "shell_end" ||
    event.type === "side_start" ||
    event.type === "side_end" ||
    event.type === "side_dismiss"
  );
}

export class TranscriptWriter {
  private readonly written = new Map<string, { message: ChatMessage; seq: number }>();
  private readonly writtenTools = new Map<string, ToolResult>();
  private latest: Transcript;
  private timer: NodeJS.Timeout | null = null;
  /** Some change since the last write wasn't pushed to clients as events (I-122). */
  private unpushed = false;

  constructor(
    private readonly store: Store,
    private readonly sessionId: string,
    /** What the store holds now. */
    stored: Transcript,
    private readonly intervalMs = 250,
    private readonly log?: (msg: string) => void,
  ) {
    stored.messages.forEach((message, seq) => this.written.set(message.id, { message, seq }));
    for (const r of Object.values(stored.toolResults)) this.writtenTools.set(r.toolCallId, r);
    this.latest = stored;
  }

  /**
   * The transcript changed: write now (`urgent`) or within `intervalMs`. `pushed`: clients got the
   * change as `session_event`s (the event-log row then only marks the seq, I-122); otherwise the
   * row's messages are sent to them as content.
   */
  update(transcript: Transcript, urgent = false, pushed = true): void {
    if (transcript === this.latest && !urgent) return;
    if (transcript !== this.latest && !pushed) this.unpushed = true;
    this.latest = transcript;
    if (urgent) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.intervalMs);
      this.timer.unref();
    }
  }

  /** Write every change not written yet. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const messages: Array<{ message: ChatMessage; seq: number }> = [];
    this.latest.messages.forEach((message, seq) => {
      const before = this.written.get(message.id);
      if (before && before.message === message && before.seq === seq) return;
      messages.push({ message, seq });
    });
    const tools = Object.values(this.latest.toolResults).filter((r) => this.writtenTools.get(r.toolCallId) !== r);
    if (!messages.length && !tools.length) return;
    if (this.store.isClosed) return;
    try {
      this.store.saveTranscriptChanges(this.sessionId, messages, tools, { pushed: !this.unpushed });
    } catch (err) {
      // Keep them pending; the next flush retries (e.g. the database was busy for too long).
      this.log?.(`session ${this.sessionId}: could not save the conversation: ${(err as Error).message}`);
      return;
    }
    this.unpushed = false;
    for (const m of messages) this.written.set(m.message.id, m);
    for (const r of tools) this.writtenTools.set(r.toolCallId, r);
  }

  /** Stop the timer after writing what's pending. */
  close(): void {
    this.flush();
  }
}
