import { describe, expect, it } from "vitest";
import type { AssistantMessage, ContentBlock, ChatMessage, ToolResult, Transcript } from "@glade/protocol";
import { DEFAULT_GROUPING_OPTIONS, groupTranscript, type RenderItem, type ToolGroupPart, type TurnPart } from "./grouping";

let seq = 0;
const call = (id: string, name = "bash", args: Record<string, unknown> | undefined = { command: `echo ${id}` }): ContentBlock => ({
  type: "toolCall",
  id,
  name,
  args,
});
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const thinking = (t: string, redacted = false): ContentBlock => ({ type: "thinking", text: t, redacted });
const assistant = (content: ContentBlock[], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: `a${seq++}`,
  role: "assistant",
  content,
  timestamp: 0,
  ...extra,
});
const user = (t: string): ChatMessage => ({ id: `u${seq++}`, role: "user", content: [{ type: "text", text: t }], timestamp: 0 });
const done = (id: string, status: ToolResult["status"] = "done"): ToolResult => ({ toolCallId: id, toolName: "bash", status, output: "" });

function transcript(messages: ChatMessage[], results: ToolResult[] = []): Transcript {
  return { messages, toolResults: Object.fromEntries(results.map((r) => [r.toolCallId, r])) };
}

const idle = { isRunning: false };
const running = { isRunning: true };

function turnParts(items: RenderItem[], index = 0): TurnPart[] {
  const turns = items.filter((i) => i.type === "turn");
  const turn = turns[index];
  if (!turn || turn.type !== "turn") throw new Error("no turn");
  return turn.parts;
}

const shape = (parts: TurnPart[]) =>
  parts.map((p) => (p.type === "toolGroup" ? `group(${p.calls.length})` : p.type === "tool" ? `tool:${p.call.id}` : p.type));

describe("groupTranscript", () => {
  it("collapses 4 consecutive calls spread over several assistant messages into one group", () => {
    const t = transcript(
      [user("hi"), assistant([call("c1"), call("c2")]), assistant([call("c3")]), assistant([call("c4")]), assistant([text("done")])],
      ["c1", "c2", "c3", "c4"].map((id) => done(id)),
    );
    const items = groupTranscript(t, idle);
    expect(items.map((i) => i.type)).toEqual(["user", "turn"]);
    const parts = turnParts(items);
    expect(shape(parts)).toEqual(["group(4)", "text"]);
    const group = parts[0] as ToolGroupPart;
    expect(group.calls.map((c) => c.call.id)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(group.active).toBe(false);
    expect(group.errorCount).toBe(0);
  });

  it("splits groups on visible thinking when thinkingBreaksGroups is true", () => {
    const t = transcript([assistant([call("c1"), call("c2"), thinking("hmm"), call("c3"), call("c4")])], ["c1", "c2", "c3", "c4"].map((id) => done(id)));
    expect(shape(turnParts(groupTranscript(t, idle)))).toEqual(["group(2)", "thinking", "group(2)"]);
  });

  it("keeps one group across thinking when thinkingBreaksGroups is false (thinking goes inside the group)", () => {
    const t = transcript([assistant([call("c1"), thinking("hmm"), call("c2"), thinking("after")])], [done("c1"), done("c2")]);
    const parts = turnParts(groupTranscript(t, idle, { ...DEFAULT_GROUPING_OPTIONS, thinkingBreaksGroups: false }));
    expect(shape(parts)).toEqual(["group(2)", "thinking"]);
    const group = parts[0] as ToolGroupPart;
    expect(group.items.map((i) => i.type)).toEqual(["tool", "thinking", "tool"]);
  });

  it("ignores empty or redacted thinking (does not split)", () => {
    const t = transcript([assistant([call("c1"), thinking("", false), thinking("secret", true), call("c2")])], [done("c1"), done("c2")]);
    expect(shape(turnParts(groupTranscript(t, idle)))).toEqual(["group(2)"]);
  });

  it("splits on text; whitespace-only text does not split", () => {
    const t = transcript(
      [assistant([call("c1"), text("  \n"), call("c2"), text("Now editing"), call("c3"), call("c4")])],
      ["c1", "c2", "c3", "c4"].map((id) => done(id)),
    );
    expect(shape(turnParts(groupTranscript(t, idle)))).toEqual(["group(2)", "text", "group(2)"]);
  });

  it("does not split on text when textBreaksGroups is false", () => {
    const t = transcript([assistant([call("c1"), text("x"), call("c2")])], [done("c1"), done("c2")]);
    const parts = turnParts(groupTranscript(t, idle, { ...DEFAULT_GROUPING_OPTIONS, textBreaksGroups: false }));
    expect(shape(parts)).toEqual(["group(2)"]);
  });

  it("renders a single call on its own (below minGroupSize)", () => {
    const t = transcript([assistant([text("Let me check"), call("c1")]), assistant([text("ok")])], [done("c1")]);
    expect(shape(turnParts(groupTranscript(t, idle)))).toEqual(["text", "tool:c1", "text"]);
  });

  it("respects a custom minGroupSize", () => {
    const t = transcript([assistant([call("c1"), call("c2")])], [done("c1"), done("c2")]);
    expect(shape(turnParts(groupTranscript(t, idle, { ...DEFAULT_GROUPING_OPTIONS, minGroupSize: 3 })))).toEqual(["tool:c1", "tool:c2"]);
    expect(shape(turnParts(groupTranscript(t, idle, { ...DEFAULT_GROUPING_OPTIONS, minGroupSize: 1 })))).toEqual(["group(2)"]);
  });

  it("never groups across a user message", () => {
    const t = transcript([assistant([call("c1")]), user("more"), assistant([call("c2")])], [done("c1"), done("c2")]);
    const items = groupTranscript(t, idle);
    expect(items.map((i) => i.type)).toEqual(["turn", "user", "turn"]);
    expect(shape(turnParts(items, 0))).toEqual(["tool:c1"]);
    expect(shape(turnParts(items, 1))).toEqual(["tool:c2"]);
  });

  it("notices end a turn", () => {
    const t = transcript([
      assistant([text("a")]),
      { id: "n1", role: "notice", kind: "compaction", text: "Compacted", timestamp: 0 },
      assistant([text("b")]),
    ]);
    expect(groupTranscript(t, idle).map((i) => i.type)).toEqual(["turn", "notice", "turn"]);
  });

  it("aggregates running and error status", () => {
    const t = transcript(
      [assistant([call("c1"), call("c2"), call("c3"), { type: "toolCall", id: "c4", name: "bash", args: undefined, argsText: "{\"com" }], { streaming: true })],
      [done("c1"), done("c2", "error"), { ...done("c3"), status: "running" }],
    );
    const group = turnParts(groupTranscript(t, running))[0] as ToolGroupPart;
    expect(group.calls.map((c) => c.status)).toEqual(["done", "error", "running", "streaming"]);
    expect(group.active).toBe(true);
    expect(group.errorCount).toBe(1);
  });

  it("marks calls without a result as pending while running and cancelled once idle", () => {
    const t = transcript([assistant([call("c1")])]);
    expect((turnParts(groupTranscript(t, running))[0] as { status: string }).status).toBe("pending");
    expect((turnParts(groupTranscript(t, idle))[0] as { status: string }).status).toBe("cancelled");
  });

  it("an idle group with no errors is not active", () => {
    const t = transcript([assistant([call("c1"), call("c2")])]);
    const group = turnParts(groupTranscript(t, idle))[0] as ToolGroupPart;
    expect(group.active).toBe(false);
  });

  it("adds an error part for failed/aborted messages and it splits groups", () => {
    const t = transcript(
      [
        assistant([call("c1")], { stopReason: "error", errorMessage: "overloaded" }),
        assistant([call("c2")], { stopReason: "aborted" }),
      ],
      [done("c1"), done("c2")],
    );
    const parts = turnParts(groupTranscript(t, idle));
    expect(shape(parts)).toEqual(["tool:c1", "error", "tool:c2", "error"]);
    expect(parts[1]).toMatchObject({ kind: "error", message: "overloaded" });
    expect(parts[3]).toMatchObject({ kind: "aborted" });
  });

  it("marks only the last block of a streaming message as streaming", () => {
    const t = transcript([assistant([thinking("plan"), text("hello")], { streaming: true })]);
    const items = groupTranscript(t, running);
    expect(items[0]).toMatchObject({ type: "turn", streaming: true });
    const parts = turnParts(items);
    expect(parts.map((p) => ("streaming" in p ? p.streaming : null))).toEqual([false, true]);
  });

  it("produces stable keys", () => {
    const t = transcript([assistant([call("c1"), call("c2")])], [done("c1"), done("c2")]);
    const a = groupTranscript(t, idle);
    const b = groupTranscript(t, idle);
    expect(a.map((i) => i.key)).toEqual(b.map((i) => i.key));
    expect(turnParts(a).map((p) => p.key)).toEqual(turnParts(b).map((p) => p.key));
  });
});
