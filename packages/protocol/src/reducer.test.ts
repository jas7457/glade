import { describe, expect, it } from "vitest";
import { applyAgentEvent } from "./reducer.js";
import { emptyTranscript, type AssistantMessage, type Transcript } from "./transcript.js";
import type { AgentEvent } from "./events.js";

const fold = (events: AgentEvent[], start: Transcript = emptyTranscript()) => events.reduce(applyAgentEvent, start);

const assistant = (id: string, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id,
  role: "assistant",
  content: [],
  timestamp: 1,
  streaming: true,
  ...extra,
});

describe("applyAgentEvent", () => {
  it("streams text into an assistant message", () => {
    const t = fold([
      { type: "message_start", message: assistant("a1") },
      { type: "block_start", messageId: "a1", index: 0, block: { type: "text", text: "" } },
      { type: "block_delta", messageId: "a1", index: 0, delta: "Hello" },
      { type: "block_delta", messageId: "a1", index: 0, delta: " world" },
    ]);
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({ content: [{ type: "text", text: "Hello world" }], streaming: true });
  });

  it("accumulates tool call argument text and replaces it on block_end", () => {
    const t = fold([
      { type: "message_start", message: assistant("a1") },
      { type: "block_start", messageId: "a1", index: 0, block: { type: "toolCall", id: "c1", name: "bash", args: undefined } },
      { type: "block_delta", messageId: "a1", index: 0, delta: '{"command":' },
    ]);
    expect(t.messages[0]).toMatchObject({ content: [{ argsText: '{"command":' }] });
    const done = applyAgentEvent(t, {
      type: "block_end",
      messageId: "a1",
      index: 0,
      block: { type: "toolCall", id: "c1", name: "bash", args: { command: "ls" } },
    });
    expect(done.messages[0]).toMatchObject({ content: [{ args: { command: "ls" } }] });
  });

  it("message_end replaces the streaming message and clears the streaming flag", () => {
    const t = fold([
      { type: "message_start", message: assistant("a1") },
      { type: "message_end", message: assistant("a1", { content: [{ type: "text", text: "final" }] }) },
    ]);
    expect(t.messages[0]).toMatchObject({ streaming: false, content: [{ text: "final" }] });
  });

  it("keeps identity of untouched messages", () => {
    const t1 = fold([
      { type: "message_start", message: { id: "u1", role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } },
      { type: "message_start", message: assistant("a1") },
      { type: "block_start", messageId: "a1", index: 0, block: { type: "text", text: "" } },
    ]);
    const t2 = applyAgentEvent(t1, { type: "block_delta", messageId: "a1", index: 0, delta: "x" });
    expect(t2.messages[0]).toBe(t1.messages[0]);
    expect(t2.messages[1]).not.toBe(t1.messages[1]);
  });

  it("tracks tool results through start/update/end", () => {
    const t = fold([
      { type: "tool_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } },
      { type: "tool_update", toolCallId: "c1", result: { toolCallId: "c1", toolName: "bash", status: "running", output: "a" } },
    ]);
    expect(t.toolResults.c1).toMatchObject({ status: "running", output: "a" });
    const done = applyAgentEvent(t, {
      type: "tool_end",
      toolCallId: "c1",
      result: { toolCallId: "c1", toolName: "bash", status: "error", output: "boom" },
    });
    expect(done.toolResults.c1).toMatchObject({ status: "error", output: "boom" });
  });

  it("ignores deltas for unknown messages and returns the same transcript for unrelated events", () => {
    const t = emptyTranscript();
    expect(applyAgentEvent(t, { type: "block_delta", messageId: "nope", index: 0, delta: "x" })).toBe(t);
    expect(applyAgentEvent(t, { type: "notify", level: "info", message: "hi" })).toBe(t);
  });

  it("run_end clears any leftover streaming flags", () => {
    const t = fold([{ type: "message_start", message: assistant("a1") }, { type: "run_end" }]);
    expect(t.messages[0]).toMatchObject({ streaming: false });
  });

  it("keeps tool timing stamps across updates (I-070)", () => {
    const r = (status: "running" | "done", output: string) => ({ toolCallId: "c1", toolName: "bash", status, output });
    const t = fold([
      { type: "tool_start", toolCallId: "c1", toolName: "bash", args: {}, at: 1000 },
      { type: "tool_update", toolCallId: "c1", result: r("running", "a") },
      { type: "tool_end", toolCallId: "c1", result: r("done", "ab"), at: 4000 },
    ]);
    expect(t.toolResults.c1).toMatchObject({ status: "done", startedAt: 1000, endedAt: 4000 });
    const unstamped = fold([{ type: "tool_start", toolCallId: "c1", toolName: "bash", args: {} }]);
    expect(unstamped.toolResults.c1?.startedAt).toBeUndefined();
  });
});
