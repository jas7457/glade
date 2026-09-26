import type { AgentEvent } from "./events.js";
import type { AssistantMessage, ChatMessage, ContentBlock, Transcript } from "./transcript.js";

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
        return { ...m, content: replaceAt(m.content, event.index, appendDelta(block, event.delta)) };
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
          },
        },
      };
    }

    case "tool_update":
    case "tool_end":
      return { ...t, toolResults: { ...t.toolResults, [event.toolCallId]: event.result } };

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
