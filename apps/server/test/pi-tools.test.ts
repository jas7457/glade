/**
 * I-068: pi's tools → canonical kinds, normalized input and diffs, for live events and history.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyAgentEvent, emptyTranscript, type AgentEvent, type AssistantMessage, type ToolCallBlock, type Transcript } from "@glade/protocol";
import { parsePiDiff, partialJsonArgs, piEdits, piToolCallBlock, piToolDiff, piToolInput, piToolKind } from "../src/harness/pi/tools.js";
import { transcriptFromPiSession } from "../src/harness/pi/transcript-file.js";
import { PiEventTranslator, translateMessages } from "../src/harness/pi/translate.js";

type Json = Record<string, unknown>;

/** One fixture per pi tool: raw call args (pi's shape) → expected kind + normalized input. */
const FIXTURES: Array<{ name: string; args: Json; kind: string; input: unknown }> = [
  { name: "bash", args: { command: "ls -la", timeout: 30 }, kind: "shell", input: { command: "ls -la" } },
  { name: "powershell", args: { command: "Get-ChildItem" }, kind: "shell", input: { command: "Get-ChildItem" } },
  { name: "read", args: { path: "src/a.ts" }, kind: "read", input: { path: "src/a.ts" } },
  { name: "read", args: { path: "src/a.ts", offset: 10, limit: 5 }, kind: "read", input: { path: "src/a.ts", offset: 10, limit: 5 } },
  { name: "write", args: { path: "b.md", content: "# Hi\n" }, kind: "write", input: { path: "b.md", content: "# Hi\n" } },
  {
    name: "edit",
    args: { path: "c.ts", edits: [{ oldText: "a", newText: "b" }] },
    kind: "edit",
    input: { path: "c.ts", edits: [{ oldText: "a", newText: "b" }] },
  },
  {
    name: "grep",
    args: { pattern: "TODO", path: "src", glob: "*.ts", ignoreCase: true, context: 2 },
    kind: "search",
    input: { pattern: "TODO", path: "src", glob: "*.ts" },
  },
  { name: "find", args: { pattern: "**/*.test.ts", path: "apps", limit: 50 }, kind: "search", input: { pattern: "**/*.test.ts", path: "apps" } },
  { name: "ls", args: { path: "src", limit: 100 }, kind: "list", input: { path: "src" } },
  { name: "ls", args: {}, kind: "list", input: {} },
  // Extension tools have no canonical shape: shown from their raw name/args.
  { name: "web_search", args: { queries: ["a", "b"] }, kind: "other", input: undefined },
  { name: "spawn_agent", args: { name: "x", task: "y" }, kind: "other", input: undefined },
  { name: "mcp__chrome_devtools", args: { tool: "take_snapshot" }, kind: "other", input: undefined },
];

describe("pi tool mapping", () => {
  it.each(FIXTURES)("$name → $kind", ({ name, args, kind, input }) => {
    expect(piToolKind(name)).toBe(kind);
    expect(piToolInput(name, args)).toEqual(input);
    const block = piToolCallBlock("t1", name, args);
    expect(block).toMatchObject({ type: "toolCall", id: "t1", name, kind, args });
    expect(block.input).toEqual(input);
  });

  it("doesn't treat Object.prototype keys as tools", () => {
    expect(piToolKind("constructor")).toBe("other");
    expect(piToolKind("toString")).toBe("other");
  });

  it("normalizes edit args in every shape pi accepts", () => {
    const e = { oldText: "a", newText: "b" };
    expect(piEdits({ path: "x", edits: [e] })).toEqual([e]);
    expect(piEdits({ path: "x", edits: JSON.stringify([e, e]) })).toEqual([e, e]);
    expect(piEdits({ path: "x", edits: e })).toEqual([e]);
    expect(piEdits({ path: "x", oldText: "a", newText: "b" })).toEqual([e]);
    expect(piEdits({ path: "x", edits: "{not json" })).toEqual([]);
    expect(piEdits({ path: "x", edits: [e, { oldText: 1 }, { extra: true, ...e }] })).toEqual([e, e]);
    expect(piToolInput("edit", { path: "x", edits: JSON.stringify([e]) })).toEqual({ path: "x", edits: [e] });
  });

  it("keeps only summary fields for partial (streaming) args", () => {
    expect(piToolInput("write", { path: "b.md", content: "partial…" }, { partial: true })).toEqual({ path: "b.md" });
    expect(piToolInput("edit", { path: "c.ts", edits: [{ oldText: "a", newText: "b" }] }, { partial: true })).toEqual({ path: "c.ts" });
    expect(piToolInput("bash", {}, { partial: true })).toEqual({});
  });

  it("parses partial JSON args", () => {
    expect(partialJsonArgs('{"a":1}')).toEqual({ a: 1 });
    expect(partialJsonArgs('{"path":"a\\"b","x":"unterminated')).toEqual({ path: 'a"b' });
    expect(partialJsonArgs(undefined)).toEqual({});
  });
});

describe("pi edit diff", () => {
  it("parses +/-/context lines with line numbers and gaps", () => {
    const lines = parsePiDiff([" 1 keep", "-2 old", "+2 new", "   ...", " 9 tail"].join("\n"));
    expect(lines).toEqual([
      { type: "context", text: "keep", oldLine: 1 },
      { type: "del", text: "old", oldLine: 2 },
      { type: "add", text: "new", newLine: 2 },
      { type: "gap", text: "" },
      { type: "context", text: "tail", oldLine: 9 },
    ]);
  });

  it("keeps indentation and handles padded line numbers", () => {
    const lines = parsePiDiff(["-  9   return a;", "+ 10   return b;", "    ..."].join("\n"));
    expect(lines).toEqual([
      { type: "del", text: "  return a;", oldLine: 9 },
      { type: "add", text: "  return b;", newLine: 10 },
      { type: "gap", text: "" },
    ]);
  });

  it("only edit results with a diff string get a normalized diff", () => {
    expect(piToolDiff("edit", { diff: "-1 a\n+1 b", patch: "…" })).toHaveLength(2);
    expect(piToolDiff("edit", { patch: "…" })).toBeUndefined();
    expect(piToolDiff("edit", undefined)).toBeUndefined();
    expect(piToolDiff("bash", { diff: "-1 a" })).toBeUndefined();
  });
});

/** Recorded pi session file (sandbox): read, bash, edit. */
const SESSION = readFileSync(new URL("./fixtures/pi-session-tools.jsonl", import.meta.url), "utf8");

function toolCalls(t: Transcript): ToolCallBlock[] {
  return t.messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((b): b is ToolCallBlock => b.type === "toolCall") : []));
}

describe("history (session file)", () => {
  const t = transcriptFromPiSession(SESSION);

  it("normalizes each tool call", () => {
    const calls = toolCalls(t);
    expect(calls.map((c) => [c.name, c.kind])).toEqual([
      ["read", "read"],
      ["bash", "shell"],
      ["edit", "edit"],
    ]);
    expect(calls[0]!.input).toEqual({ path: "src/greet.js" });
    expect(calls[1]!.input).toEqual({ command: "ls -la src" });
    expect(calls[2]!.input).toEqual({
      path: "src/greet.js",
      edits: [{ oldText: "return `Hello, ${name}!`;", newText: "return `Howdy, ${name}!`;" }],
    });
  });

  it("normalizes the edit's diff and leaves other results without one", () => {
    const [read, bash, edit] = toolCalls(t).map((c) => t.toolResults[c.id]!);
    expect(read!.diff).toBeUndefined();
    expect(bash!.diff).toBeUndefined();
    expect(edit!.diff).toEqual([
      { type: "context", text: "export function greet(name) {", oldLine: 1 },
      { type: "del", text: "  return `Hello, ${name}!`;", oldLine: 2 },
      { type: "add", text: "  return `Howdy, ${name}!`;", newLine: 2 },
      { type: "context", text: "}", oldLine: 3 },
    ]);
  });

  it("get_messages history is normalized the same way", () => {
    const raw = [
      { role: "assistant", content: [{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "x", path: "src" } }], timestamp: 1 },
      { role: "toolResult", toolCallId: "g1", toolName: "grep", content: [{ type: "text", text: "src/a.ts:1: x" }], isError: false },
    ];
    const h = translateMessages(raw, (i) => `h${i}`);
    expect((h.messages[0] as AssistantMessage).content[0]).toMatchObject({ kind: "search", input: { pattern: "x", path: "src" } });
  });
});

describe("live events", () => {
  const update = (e: Json): Json => ({ type: "message_update", assistantMessageEvent: e });

  function run(events: Json[]): { out: AgentEvent[]; t: Transcript } {
    const tr = new PiEventTranslator();
    const out = events.flatMap((e) => tr.translate(e));
    return { out, t: out.reduce(applyAgentEvent, emptyTranscript()) };
  }

  const start = { type: "message_start", message: { role: "assistant", content: [], timestamp: 1 } };

  it("knows the kind at block_start and fills the input while args stream", () => {
    const { out, t } = run([
      start,
      update({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: '{"comm' }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: 'and":"git st' }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: 'atus"' }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: "}" }),
    ]);
    expect(out[1]).toMatchObject({ type: "block_start", block: { type: "toolCall", kind: "shell", args: undefined } });
    const deltas = out.filter((e): e is Extract<AgentEvent, { type: "block_delta" }> => e.type === "block_delta");
    expect(deltas).toHaveLength(4);
    // The input is sent only when it changes: here once the command string is complete.
    expect(deltas.map((d) => d.input)).toEqual([undefined, undefined, { command: "git status" }, undefined]);
    const block = (t.messages[0] as AssistantMessage).content[0] as ToolCallBlock;
    expect(block).toMatchObject({ kind: "shell", input: { command: "git status" }, args: undefined, argsText: '{"command":"git status"}' });
  });

  it("never streams bulky write content as partial input", () => {
    const { out } = run([
      start,
      update({ type: "toolcall_start", contentIndex: 0, id: "w1", toolName: "write" }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a.md","content":"line 1\\n' }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: 'line 2"}' }),
    ]);
    const inputs = out.flatMap((e) => (e.type === "block_delta" && e.input ? [e.input] : []));
    expect(inputs).toEqual([{ path: "a.md" }]);
  });

  it("other tools stream raw deltas only", () => {
    const { out } = run([
      start,
      update({ type: "toolcall_start", contentIndex: 0, id: "o1", toolName: "web_search" }),
      update({ type: "toolcall_delta", contentIndex: 0, delta: '{"query":"x"}' }),
    ]);
    expect(out[1]).toMatchObject({ type: "block_start", block: { kind: "other" } });
    expect(out[2]).toEqual({ type: "block_delta", messageId: "m0", index: 0, delta: '{"query":"x"}' });
  });

  it("block_end carries the complete normalized input; tool_end the normalized diff", () => {
    const edits = [{ oldText: "a", newText: "b" }];
    const { out, t } = run([
      start,
      update({ type: "toolcall_start", contentIndex: 0, id: "e1", toolName: "edit" }),
      update({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "e1", name: "edit", arguments: { path: "x.ts", edits: JSON.stringify(edits) } } }),
      { type: "tool_execution_start", toolCallId: "e1", toolName: "edit", args: { path: "x.ts", edits } },
      {
        type: "tool_execution_end",
        toolCallId: "e1",
        toolName: "edit",
        result: { content: [{ type: "text", text: "ok" }], details: { diff: "-1 a\n+1 b", patch: "" } },
        isError: false,
      },
    ]);
    expect(out.find((e) => e.type === "block_end")).toMatchObject({ block: { kind: "edit", input: { path: "x.ts", edits } } });
    expect(t.toolResults.e1).toMatchObject({
      status: "done",
      diff: [
        { type: "del", text: "a", oldLine: 1 },
        { type: "add", text: "b", newLine: 1 },
      ],
    });
  });
});
