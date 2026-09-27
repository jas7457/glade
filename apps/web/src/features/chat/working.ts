/**
 * The transcript's "Working…" row (I-063, I-072): when it is shown and what it says. Pure, so
 * the rule lives in one tested place.
 *
 *   - The row belongs to the whole run: it's mounted while the agent runs and only *hidden*
 *     while the reply's visible text streams (the user is reading that instead). Tool-call
 *     argument streaming, running tools, gaps between them and hidden thinking keep it shown,
 *     so it doesn't blink between tool calls.
 *     It also stays hidden after a final reply (last message ended with `stop`) until `run_end`
 *     arrives, so it doesn't flash back up for the moment between the two.
 *   - "Thinking…" while an empty/redacted thinking block streams (current Claude models send
 *     only a signed placeholder, so nothing else would show), "Compacting context…" while
 *     compacting, else "Working…".
 */
import type { AssistantMessage, SessionState, Transcript } from "@glade/protocol";

export type WorkingLabel = "Working…" | "Thinking…" | "Compacting context…";

export interface WorkingStatus {
  /** Keep the row's slot in the layout (the whole run). */
  mounted: boolean;
  /** Show its content (false while reply text streams). */
  visible: boolean;
  label: WorkingLabel;
}

type StateLike = Pick<SessionState, "isRunning" | "isCompacting" | "runStartedAt">;

/** The assistant message currently streaming, if any (the last one). */
function streamingMessage(transcript: Transcript): AssistantMessage | null {
  for (let i = transcript.messages.length - 1; i >= 0; i--) {
    const m = transcript.messages[i]!;
    if (m.role === "assistant" && m.streaming) return m;
  }
  return null;
}

export function workingStatus(transcript: Transcript, state: StateLike): WorkingStatus {
  const label: WorkingLabel = state.isCompacting ? "Compacting context…" : "Working…";
  if (!state.isRunning) return { mounted: false, visible: false, label };
  const last = transcript.messages[transcript.messages.length - 1];
  const finalReply =
    last?.role === "assistant" &&
    !last.streaming &&
    last.stopReason === "stop" &&
    // Not the previous run's reply (a new run starts before its user message arrives).
    (state.runStartedAt == null || last.timestamp >= state.runStartedAt);
  if (finalReply && !state.isCompacting) return { mounted: true, visible: false, label };
  const content = streamingMessage(transcript)?.content ?? [];
  const block = content[content.length - 1];
  if (block?.type === "text" && block.text.trim().length > 0) return { mounted: true, visible: false, label };
  if (!state.isCompacting && block?.type === "thinking" && (block.redacted || !block.text.trim())) {
    return { mounted: true, visible: true, label: "Thinking…" };
  }
  return { mounted: true, visible: true, label };
}
