/**
 * I-119: ACP session updates → Glade events (pure translator + tool mapping).
 */
import { describe, expect, it } from "vitest";
import { applyAgentEvent, emptyTranscript, messageText, type AgentEvent, type AssistantMessage, type Transcript } from "@glade/protocol";
import { AcpTranslator } from "../src/harness/acp/translate.js";
import { acpToolBlock, acpToolKind, newToolState } from "../src/harness/acp/tools.js";

function fold(events: AgentEvent[], t: Transcript = emptyTranscript()): Transcript {
  return events.reduce(applyAgentEvent, t);
}

const chunk = (text: string, messageId?: string) => ({ sessionUpdate: "agent_message_chunk" as const, content: { type: "text" as const, text }, ...(messageId ? { messageId } : {}) });

describe("AcpTranslator", () => {
  it("streams text into one message and closes it with the stop reason", () => {
    const tr = new AcpTranslator("x", () => 1);
    const events = [...tr.update(chunk("Hi ")), ...tr.update(chunk("you")), ...tr.finish({ stopReason: "max_tokens" })];
    const t = fold(events);
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0]).toMatchObject({ role: "assistant", stopReason: "length", streaming: false, content: [{ type: "text", text: "Hi you" }] });
  });

  it("starts a new message after tool calls and when the ACP message id changes", () => {
    const tr = new AcpTranslator("x", () => 1);
    const events = [
      ...tr.update(chunk("a", "m1")),
      ...tr.update({ sessionUpdate: "tool_call", toolCallId: "t", title: "Read file", kind: "read", locations: [{ path: "/p/f.ts", line: 3 }] }),
      ...tr.update(chunk("b", "m1")),
      ...tr.update(chunk("c", "m2")),
      ...tr.finish({ stopReason: "end_turn" }),
    ];
    const t = fold(events);
    const texts = t.messages.map((m) => messageText(m));
    expect(texts).toEqual(["a", "b", "c"]);
    expect((t.messages[0] as AssistantMessage).stopReason).toBe("toolUse");
    expect((t.messages[0] as AssistantMessage).content[1]).toMatchObject({ type: "toolCall", kind: "read", input: { path: "/p/f.ts", offset: 3 } });
    // The unfinished tool call is settled when the turn ends.
    expect(t.toolResults.t?.status).toBe("error");
  });

  it("re-sends a tool block when an update changes it, and ends it on completion", () => {
    const tr = new AcpTranslator("x", () => 1);
    const events = [
      ...tr.update({ sessionUpdate: "tool_call", toolCallId: "t", title: "Search", kind: "search", status: "pending" }),
      ...tr.update({ sessionUpdate: "tool_call_update", toolCallId: "t", rawInput: { pattern: "TODO", path: "/p" } }),
      ...tr.update({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "failed", content: [{ type: "content", content: { type: "text", text: "boom" } }] }),
      ...tr.finish({ stopReason: "end_turn" }),
    ];
    const t = fold(events);
    expect((t.messages[0] as AssistantMessage).content[0]).toMatchObject({ kind: "search", input: { pattern: "TODO", path: "/p" } });
    expect(t.toolResults.t).toMatchObject({ status: "error", output: "boom" });
    expect(events.filter((e) => e.type === "tool_end")).toHaveLength(1);
  });

  it("marks tool calls cut off by a stop as stopped, not failed (I-190)", () => {
    const tr = new AcpTranslator("x", () => 1);
    tr.update({ sessionUpdate: "tool_call", toolCallId: "r", title: "Edit", kind: "edit", status: "pending" });
    tr.rejectTool("r");
    const t = fold([
      ...tr.update({ sessionUpdate: "tool_call", toolCallId: "t", title: "Run", kind: "execute", status: "in_progress" }),
      ...tr.finish({ stopReason: "cancelled" }),
    ]);
    expect(t.toolResults.t).toMatchObject({ status: "error", stopped: true });
    expect(t.toolResults.r).toMatchObject({ status: "error", rejected: true });
    expect(t.toolResults.r?.stopped).toBeUndefined();
  });

  it("adds an error message when a failed turn produced nothing", () => {
    const tr = new AcpTranslator("x", () => 1);
    const t = fold(tr.finish({ error: "Internal error", details: "oops" }));
    expect(t.messages[0]).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "Internal error", errorDetails: "oops", content: [] });
  });

  it("ignores replayed user chunks and metadata updates", () => {
    const tr = new AcpTranslator("x", () => 1);
    expect(tr.update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "old" } })).toEqual([]);
    expect(tr.update({ sessionUpdate: "current_mode_update", currentModeId: "ask" })).toEqual([]);
  });
});

describe("ACP tool kinds", () => {
  const kind = (k: Parameters<typeof newToolState>[0]["kind"], extra = {}) => acpToolKind(newToolState({ toolCallId: "t", title: "T", kind: k, ...extra }));

  it("maps ACP kinds to Glade kinds", () => {
    expect(kind("read")).toBe("read");
    expect(kind("edit")).toBe("edit");
    expect(kind("edit", { content: [{ type: "diff", path: "/a", newText: "x" }] })).toBe("write");
    expect(kind("search")).toBe("search");
    expect(kind("execute")).toBe("shell");
    expect(kind("fetch")).toBe("web");
    for (const k of ["delete", "move", "think", "switch_mode", "other", undefined] as const) expect(kind(k)).toBe("other");
  });

  it("shows `other` tools by their title and keeps locations in args", () => {
    const block = acpToolBlock(newToolState({ toolCallId: "t", title: "Delete old.ts", kind: "delete", locations: [{ path: "/p/old.ts" }] }));
    expect(block).toEqual({ type: "toolCall", id: "t", name: "Delete old.ts", kind: "other", args: { locations: ["/p/old.ts"] } });
  });

  it("normalizes shell commands given as arrays and fetch URLs", () => {
    expect(acpToolBlock(newToolState({ toolCallId: "t", title: "Run", kind: "execute", rawInput: { command: ["git", "status"] } })).input).toEqual({ command: "git status", description: "Run" });
    expect(acpToolBlock(newToolState({ toolCallId: "t", title: "Fetch", kind: "fetch", rawInput: { url: "https://x.dev" } })).input).toEqual({ url: "https://x.dev" });
  });
});
