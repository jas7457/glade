import type { AgentEvent } from "./events.js";
import type { SideQuestionMessage, SideQuestionTurn } from "./side-questions.js";
import type { AssistantMessage, ChatMessage, ContentBlock, ShellMessage, Transcript } from "./transcript.js";

/**
 * Fold an {@link AgentEvent} into a transcript. Pure and immutable: unchanged messages keep
 * their identity so UI components can memoize on them. Events that don't affect the
 * transcript return the same object.
 */
export function applyAgentEvent(t: Transcript, event: AgentEvent): Transcript {
  switch (event.type) {
    case "message_start":
    case "message_end": {
      const message: ChatMessage =
        event.type === "message_end" && event.message.role === "assistant"
          ? { ...event.message, streaming: false }
          : event.message;
      const idx = t.messages.findIndex((m) => m.id === message.id);
      if (idx === -1) return { ...t, messages: [...t.messages, message] };
      // message_start for a message we already have (e.g. after a resync) - keep existing.
      if (event.type === "message_start") return t;
      return { ...t, messages: replaceAt(t.messages, idx, message) };
    }

    case "block_start":
      return updateAssistant(t, event.messageId, (m) => ({
        ...m,
        content: setAt(m.content, event.index, event.block),
      }));

    case "block_delta":
      return updateAssistant(t, event.messageId, (m) => {
        const block = m.content[event.index];
        if (!block) return m;
        let next = appendDelta(block, event.delta);
        if (event.input && next.type === "toolCall") next = { ...next, input: event.input };
        return { ...m, content: replaceAt(m.content, event.index, next) };
      });

    case "block_end":
      return updateAssistant(t, event.messageId, (m) => ({
        ...m,
        content: setAt(m.content, event.index, event.block),
      }));

    case "tool_start": {
      const existing = t.toolResults[event.toolCallId];
      if (existing && existing.status !== "running") return t;
      return {
        ...t,
        toolResults: {
          ...t.toolResults,
          [event.toolCallId]: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            status: "running",
            output: existing?.output ?? "",
            ...(event.at !== undefined ? { startedAt: event.at } : existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
          },
        },
      };
    }

    case "tool_update":
    case "tool_end": {
      // Harness results don't carry timing: keep the start stamp, add the end stamp (I-070).
      const existing = t.toolResults[event.toolCallId];
      const result = { ...event.result };
      const startedAt = result.startedAt ?? existing?.startedAt;
      if (startedAt !== undefined) result.startedAt = startedAt;
      const endedAt = event.type === "tool_end" ? (result.endedAt ?? event.at) : result.endedAt;
      if (endedAt !== undefined) result.endedAt = endedAt;
      return { ...t, toolResults: { ...t.toolResults, [event.toolCallId]: result } };
    }

    case "shell_start": {
      if (t.messages.some((m) => m.id === event.id)) return t;
      const message: ShellMessage = {
        id: event.id,
        role: "shell",
        command: event.command,
        shared: event.shared,
        running: true,
        output: "",
        exitCode: null,
        cancelled: false,
        truncated: false,
        timestamp: event.at ?? Date.now(),
      };
      return { ...t, messages: [...t.messages, message] };
    }

    case "shell_update":
      return updateShell(t, event.id, (m) => (m.running && event.delta ? { ...m, output: m.output + event.delta } : m));

    case "shell_end":
      return updateShell(t, event.id, (m) => {
        const { fullOutputPath, error, ...result } = event.result;
        const next: ShellMessage = { ...m, ...result, running: false };
        delete next.fullOutputPath;
        delete next.error;
        if (fullOutputPath) next.fullOutputPath = fullOutputPath;
        if (error) next.error = error;
        if (event.at !== undefined) next.endedAt = event.at;
        return next;
      });

    case "side_start": {
      if (t.messages.some((m) => m.id === event.id)) return t;
      const turn: SideQuestionTurn = {
        id: event.id,
        question: event.question,
        answer: "",
        status: "streaming",
        timestamp: event.at ?? Date.now(),
        ...(event.model ? { model: event.model } : {}),
        ...(event.partialContext ? { partialContext: true } : {}),
      };
      if (event.parentId) {
        // A follow-up in an existing card (I-156).
        const parentId = event.parentId;
        return updateSide(t, parentId, (m) =>
          m.id !== parentId || m.followUps?.some((f) => f.id === event.id) ? m : { ...m, followUps: [...(m.followUps ?? []), turn] },
        );
      }
      const message: SideQuestionMessage = { ...turn, role: "side" };
      return { ...t, messages: [...t.messages, message] };
    }

    case "side_delta":
      return updateSideTurn(t, event.id, (m) => (m.status === "streaming" && event.delta ? { ...m, answer: m.answer + event.delta } : m));

    case "side_end":
      return updateSideTurn(t, event.id, (m) => {
        const next = { ...m, status: event.status, answer: event.answer ?? m.answer };
        delete next.error;
        if (event.error) next.error = event.error;
        if (event.at !== undefined) next.endedAt = event.at;
        return next;
      });

    case "side_dismiss":
      return updateSide(t, event.id, (m) => (m.dismissed ? m : { ...m, dismissed: true }));

    case "run_end": {
      // Safety net: nothing can still be streaming once the run is over.
      let changed = false;
      const messages = t.messages.map((m) => {
        if (m.role === "assistant" && m.streaming) {
          changed = true;
          return { ...m, streaming: false };
        }
        return m;
      });
      return changed ? { ...t, messages } : t;
    }

    default:
      return t;
  }
}

function updateAssistant(
  t: Transcript,
  messageId: string,
  fn: (m: AssistantMessage) => AssistantMessage,
): Transcript {
  // Streaming targets are almost always the last message; search from the end.
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i]!;
    if (m.id !== messageId) continue;
    if (m.role !== "assistant") return t;
    return { ...t, messages: replaceAt(t.messages, i, fn(m)) };
  }
  return t;
}

function updateShell(t: Transcript, id: string, fn: (m: ShellMessage) => ShellMessage): Transcript {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i]!;
    if (m.id !== id) continue;
    if (m.role !== "shell") return t;
    const next = fn(m);
    return next === m ? t : { ...t, messages: replaceAt(t.messages, i, next) };
  }
  return t;
}

/** Update the side question card `id`, or the card holding the follow-up `id` (I-156). */
function updateSide(t: Transcript, id: string, fn: (m: SideQuestionMessage) => SideQuestionMessage): Transcript {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i]!;
    if (m.id !== id && !(m.role === "side" && m.followUps?.some((f) => f.id === id))) continue;
    if (m.role !== "side") return t;
    const next = fn(m);
    return next === m ? t : { ...t, messages: replaceAt(t.messages, i, next) };
  }
  return t;
}

/** Update one question of a side question card: its first (`id` = the card's) or a follow-up. */
function updateSideTurn(t: Transcript, id: string, fn: <T extends SideQuestionTurn>(turn: T) => T): Transcript {
  return updateSide(t, id, (m) => {
    if (m.id === id) return fn(m);
    const followUps = m.followUps ?? [];
    const i = followUps.findIndex((f) => f.id === id);
    if (i === -1) return m;
    const next = fn(followUps[i]!);
    return next === followUps[i] ? m : { ...m, followUps: followUps.map((f, j) => (j === i ? next : f)) };
  });
}

function appendDelta(block: ContentBlock, delta: string): ContentBlock {
  switch (block.type) {
    case "text":
      return { ...block, text: block.text + delta };
    case "thinking":
      return { ...block, text: block.text + delta };
    case "toolCall":
      return { ...block, argsText: (block.argsText ?? "") + delta };
    default:
      return block;
  }
}

function replaceAt<T>(arr: readonly T[], idx: number, value: T): T[] {
  const copy = arr.slice();
  copy[idx] = value;
  return copy;
}

/** Like replaceAt but allows writing past the end (filling gaps with empty text blocks). */
function setAt(arr: readonly ContentBlock[], idx: number, value: ContentBlock): ContentBlock[] {
  const copy = arr.slice();
  while (copy.length < idx) copy.push({ type: "text", text: "" });
  copy[idx] = value;
  return copy;
}
