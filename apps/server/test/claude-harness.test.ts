/**
 * I-173: Claude Code as a native harness, against a scripted fake of the Claude Agent SDK
 * (`fixtures/fake-claude-sdk.ts`; never the real CLI or a model). Covers the translator (streaming,
 * tools, diffs, plans, errors), sessions (start, resume, steer/follow-up, stop, crash, sign-in,
 * permissions, questions, model/thinking, compaction), the harness (models, commands, titles,
 * Glade's tools) and a chat through the app service.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAgentEvent, messageText, type AgentEvent, type AssistantMessage, type NoticeMessage, type Transcript, type UiRequest } from "@glade/protocol";
import { ClaudeHarness, CLAUDE_CAPABILITIES } from "../src/harness/claude/claude-harness.js";
import type { ClaudeSession } from "../src/harness/claude/claude-session.js";
import { friendlyError } from "../src/harness/claude/claude-session.js";
import { claudeToolAllowlist, gladeToolSpecs } from "../src/harness/claude/glade-tools.js";
import { claudeModelLabel, claudeThinkingLevels, thinkingOptions, translateClaudeModels } from "../src/harness/claude/models.js";
import { alwaysAllowLabel, claudePermissionModes, readClaudePermissionSettings } from "../src/harness/claude/permissions.js";
import { claudeToolBlock, structuredPatchDiff } from "../src/harness/claude/tools.js";
import { ClaudeTranslator } from "../src/harness/claude/translate.js";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import type { NativeSubagentEvent } from "../src/harness/types.js";
import { AppService } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";
import { FAKE_INIT, FakeClaudeSdk, assistant, result, stream, subToolResult, toolResult } from "./fixtures/fake-claude-sdk.js";
import { flush, until } from "./helpers.js";

let dir: string;
let cwd: string;
const open: ClaudeSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glade-claude-"));
  cwd = join(dir, "project");
  mkdirSync(cwd);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  rmSync(dir, { recursive: true, force: true });
});

function harness(sdk: FakeClaudeSdk, extra: Partial<ConstructorParameters<typeof ClaudeHarness>[0]> = {}): ClaudeHarness {
  return new ClaudeHarness({
    sdk,
    utilityCwd: dir,
    which: () => true,
    findExecutable: () => "/usr/local/bin/claude",
    env: { PATH: "/usr/bin", HOME: "/Users/me", GLADE_TOKEN: "server-secret", CLAUDECODE: "1" },
    session: { cancelGraceMs: 50, home: "/Users/me" },
    permissionSettings: () => ({ defaultMode: null, bypassDisabled: false }),
    ...extra,
  });
}

async function openSession(h: ClaudeHarness, sessionRef: string | null = null, env: Record<string, string> = {}) {
  const session = (await h.openSession({ cwd, sessionRef, env })) as ClaudeSession;
  open.push(session);
  const events: AgentEvent[] = [];
  const exits: Array<Error | null> = [];
  session.onEvent((e) => events.push(e));
  session.onExit((e) => exits.push(e));
  const runEnds = () => events.filter((e) => e.type === "run_end").length;
  const run = async (text: string) => {
    const before = runEnds();
    await session.prompt({ text });
    await until(() => runEnds() > before, 2000);
  };
  return { session, events, exits, run };
}

const assistants = (t: Transcript) => t.messages.filter((m): m is AssistantMessage => m.role === "assistant");

// ---------------------------------------------------------------------------------------------

describe("Claude translator", () => {
  it("streams text and thinking, then confirms them with the assistant message", () => {
    const t = new ClaudeTranslator("p", () => 1);
    let transcript: Transcript = { messages: [], toolResults: {} };
    const apply = (events: AgentEvent[]) => events.forEach((e) => (transcript = foldEvent(transcript, e)));
    apply(t.message(stream({ type: "message_start", message: { id: "m1" } })));
    apply(t.message(stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })));
    apply(t.message(stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Hmm" } })));
    apply(t.message(stream({ type: "content_block_stop", index: 0 })));
    apply(t.message(assistant("m1", [{ type: "thinking", thinking: "Hmm", signature: "x" }])));
    apply(t.message(stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })));
    apply(t.message(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hi " } })));
    apply(t.message(stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "there" } })));
    apply(t.message(stream({ type: "content_block_stop", index: 1 })));
    apply(t.message(assistant("m1", [{ type: "text", text: "Hi there" }])));
    apply(t.finish({ stopReason: "stop" }));
    const [reply] = assistants(transcript);
    expect(reply!.content).toEqual([
      { type: "thinking", text: "Hmm" },
      { type: "text", text: "Hi there" },
    ]);
    expect(reply!.stopReason).toBe("stop");
    expect(reply!.model).toBe("claude-sonnet-5");
  });

  it("leaves no empty message for a response that never streams a block", () => {
    const t = new ClaudeTranslator("p");
    const events = [
      ...t.message(assistant("m1", [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "n.txt", content: "hi" } }])),
      ...t.message(toolResult("w1", "ok")),
      ...t.message(stream({ type: "message_start", message: { id: "m2" } })),
      ...t.message(stream({ type: "message_start", message: { id: "m3" } })),
      ...t.message(stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })),
      ...t.message(stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } })),
      ...t.message(stream({ type: "content_block_stop", index: 0 })),
      ...t.message(assistant("m3", [{ type: "text", text: "Done" }])),
      ...t.finish({ stopReason: "stop" }),
    ];
    const transcript = events.reduce(foldEvent, { messages: [], toolResults: {} } as Transcript);
    expect(assistants(transcript).map((m) => [m.content.map((b) => b.type), m.stopReason])).toEqual([
      [["toolCall"], "toolUse"],
      [["text"], "stop"],
    ]);
  });

  it("builds the reply from assistant messages alone (no partial messages)", () => {
    const t = new ClaudeTranslator("p");
    const events = [...t.message(assistant("m1", [{ type: "text", text: "One" }])), ...t.message(assistant("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls", description: "List" } }]))];
    events.push(...t.message(toolResult("t1", "a\nb")), ...t.message(assistant("m2", [{ type: "text", text: "Done" }])), ...t.finish({ stopReason: "stop" }));
    const transcript = events.reduce(foldEvent, { messages: [], toolResults: {} } as Transcript);
    const [first, second] = assistants(transcript);
    expect(first!.content).toEqual([{ type: "text", text: "One" }, claudeToolBlock("t1", "Bash", { command: "ls", description: "List" })]);
    expect(first!.content[1]).toMatchObject({ kind: "shell", input: { command: "ls", description: "List" } });
    expect(first!.stopReason).toBe("toolUse");
    expect(second!.content).toEqual([{ type: "text", text: "Done" }]);
    expect(transcript.toolResults.t1).toMatchObject({ status: "done", output: "a\nb", toolName: "Bash" });
  });

  it("streams tool arguments with a partial input, then the full call", () => {
    const t = new ClaudeTranslator("p");
    const events = [
      ...t.message(stream({ type: "message_start", message: { id: "m1" } })),
      ...t.message(stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Write", input: {} } })),
      ...t.message(stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"a.txt","content":"he' } })),
      ...t.message(stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'llo"}' } })),
      ...t.message(stream({ type: "content_block_stop", index: 0 })),
    ];
    const deltas = events.filter((e) => e.type === "block_delta");
    expect(deltas[0]).toMatchObject({ input: { path: "a.txt" } });
    expect((deltas[0] as { input?: object }).input).not.toHaveProperty("content");
    expect(events.find((e) => e.type === "tool_start")).toMatchObject({ toolCallId: "t1", toolName: "Write", args: { file_path: "a.txt", content: "hello" } });
    const end = events.filter((e) => e.type === "block_end").at(-1);
    expect(end).toMatchObject({ block: { kind: "write", input: { path: "a.txt", content: "hello" } } });
    // The assistant message confirming it doesn't add it twice.
    expect(t.message(assistant("m1", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.txt", content: "hello" } }]))).toEqual([]);
  });

  it("keeps one call when a permission request comes before its tool call's message", () => {
    for (const streamed of [false, true]) {
      const t = new ClaudeTranslator("p");
      const events = [...t.ensureTool("r1", "Read", { file_path: "a.md" })];
      if (streamed) {
        events.push(
          ...t.message(stream({ type: "message_start", message: { id: "m1" } })),
          ...t.message(stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "r1", name: "Read", input: {} } })),
          ...t.message(stream({ type: "content_block_stop", index: 0 })),
        );
      }
      events.push(...t.message(assistant("m1", [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "a.md" } }])));
      events.push(...t.message(toolResult("r1", "# A")), ...t.message(assistant("m2", [{ type: "text", text: "ok" }])), ...t.finish({ stopReason: "stop" }));
      const transcript = events.reduce(foldEvent, { messages: [], toolResults: {} } as Transcript);
      expect(assistants(transcript).map((m) => m.content.map((b) => b.type))).toEqual([["toolCall"], ["text"]]);
      expect(events.filter((e) => e.type === "tool_start")).toHaveLength(1);
    }
  });

  it("normalizes Claude Code's tools", () => {
    expect(claudeToolBlock("1", "Read", { file_path: "/a.ts", offset: 3, limit: 10 })).toMatchObject({ kind: "read", input: { path: "/a.ts", offset: 3, limit: 10 } });
    expect(claudeToolBlock("1", "Edit", { file_path: "a", old_string: "x", new_string: "y" })).toMatchObject({ kind: "edit", input: { path: "a", edits: [{ oldText: "x", newText: "y" }] } });
    expect(claudeToolBlock("1", "MultiEdit", { file_path: "a", edits: [{ old_string: "1", new_string: "2" }] })).toMatchObject({ kind: "edit", input: { edits: [{ oldText: "1", newText: "2" }] } });
    expect(claudeToolBlock("1", "Grep", { pattern: "foo", path: "src", glob: "*.ts" })).toMatchObject({ kind: "search", input: { pattern: "foo", path: "src", glob: "*.ts" } });
    expect(claudeToolBlock("1", "Glob", { pattern: "**/*.md" })).toMatchObject({ kind: "search", input: { pattern: "**/*.md" } });
    expect(claudeToolBlock("1", "WebFetch", { url: "https://x.dev", prompt: "p" })).toMatchObject({ kind: "web", input: { url: "https://x.dev" } });
    expect(claudeToolBlock("1", "WebSearch", { query: "q" })).toMatchObject({ kind: "web", input: { query: "q" } });
    expect(claudeToolBlock("1", "Task", { description: "Find usages", prompt: "…", subagent_type: "Explore" })).toMatchObject({ kind: "task", input: { description: "Find usages", agentDefinition: "Explore" } });
    expect(claudeToolBlock("1", "Agent", { description: "Review", prompt: "…" })).toMatchObject({ kind: "task", input: { description: "Review" } });
    expect(claudeToolBlock("1", "mcp__glade__spawn_agent", { name: "scout", task: "Look around\nmore" })).toMatchObject({ kind: "task", input: { agentName: "scout", description: "Look around" } });
    expect(claudeToolBlock("1", "mcp__glade__find_chats", { query: "toolbar" })).toMatchObject({ kind: "chat", input: { chatAction: "find", query: "toolbar" } });
    expect(claudeToolBlock("1", "mcp__github__create_issue", {})).toMatchObject({ kind: "mcp", input: { server: "github", tool: "create_issue" } });
    expect(claudeToolBlock("1", "NotebookRead", {})).toMatchObject({ kind: "other" });
  });

  it("turns structuredPatch hunks into diff lines", () => {
    expect(
      structuredPatchDiff([
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" a", "-b", "+B"] },
        { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [" x", "+y", "\\ No newline at end of file"] },
      ]),
    ).toEqual([
      { type: "context", text: "a", oldLine: 1, newLine: 1 },
      { type: "del", text: "b", oldLine: 2 },
      { type: "add", text: "B", newLine: 2 },
      { type: "gap", text: "" },
      { type: "context", text: "x", oldLine: 10, newLine: 10 },
      { type: "add", text: "y", newLine: 11 },
    ]);
    const t = new ClaudeTranslator("p");
    t.message(assistant("m1", [{ type: "tool_use", id: "e1", name: "Edit", input: { file_path: "a", old_string: "b", new_string: "B" } }]));
    const [end] = t.message(toolResult("e1", "ok", { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-b", "+B"] }] }));
    expect(end).toMatchObject({ type: "tool_end", result: { status: "done", diff: [{ type: "del", text: "b" }, { type: "add", text: "B" }] } });
  });

  it("shows TodoWrite and the task list as one plan per turn, not as tool calls", () => {
    const t = new ClaudeTranslator("p");
    const plans = (events: AgentEvent[]) => events.filter((e): e is AgentEvent & { type: "message_end"; message: NoticeMessage } => e.type === "message_end" && e.message.role === "notice");
    const first = plans(t.message(assistant("m1", [{ type: "tool_use", id: "w1", name: "TodoWrite", input: { todos: [{ content: "Read", status: "completed", activeForm: "Reading" }, { content: "Fix", status: "in_progress", activeForm: "Fixing" }] } }])));
    expect(first[0]!.message).toMatchObject({ kind: "plan", plan: [{ content: "Read", status: "completed" }, { content: "Fix", status: "in_progress" }], text: "Plan\n☑ Read\n▸ Fix" });
    expect(t.message(toolResult("w1", "ok"))).toEqual([]); // no tool result for it
    const second = plans(t.message(assistant("m2", [{ type: "tool_use", id: "w2", name: "TodoWrite", input: { todos: [{ content: "Fix", status: "completed" }] } }])));
    expect(second[0]!.message.id).toBe(first[0]!.message.id); // updated in place
    const finished = t.finish({ stopReason: "stop" });
    expect(finished.some((e) => e.type === "tool_end")).toBe(false);

    const t2 = new ClaudeTranslator("q");
    t2.message(assistant("m1", [{ type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "Write tests", description: "…" } }]));
    const created = plans(t2.message(toolResult("c1", "Task #1 created", { task: { id: "1", subject: "Write tests" } })));
    expect(created[0]!.message.plan).toEqual([{ content: "Write tests", status: "pending" }]);
    const updated = plans(t2.message(assistant("m2", [{ type: "tool_use", id: "u1", name: "TaskUpdate", input: { taskId: "1", status: "in_progress" } }])));
    expect(updated[0]!.message.plan).toEqual([{ content: "Write tests", status: "in_progress" }]);
  });

  it("shows ExitPlanMode's plan as a proposed plan card, not as a tool call (I-189)", () => {
    const t = new ClaudeTranslator("p");
    const notices = (events: AgentEvent[]) => events.filter((e): e is AgentEvent & { type: "message_end"; message: NoticeMessage } => e.type === "message_end" && e.message.role === "notice");
    const shown = notices(t.message(assistant("m1", [{ type: "tool_use", id: "x1", name: "ExitPlanMode", input: { plan: "# Plan\n1. Add --version" } }])));
    expect(shown).toHaveLength(1);
    expect(shown[0]!.message).toMatchObject({ kind: "plan", text: "# Plan\n1. Add --version" });
    expect(shown[0]!.message.plan).toBeUndefined(); // no steps: the "Proposed plan" card
    expect(t.proposePlan("x1", "# Plan\n1. Add --version")).toEqual([]); // once per call
    // From the result when the input had none (a plan file), same card when it changes.
    const t2 = new ClaudeTranslator("q");
    expect(notices(t2.message(assistant("m1", [{ type: "tool_use", id: "x2", name: "ExitPlanMode", input: {} }])))).toEqual([]);
    const fromResult = notices(t2.message(toolResult("x2", "approved", { plan: "Do it", isAgent: false })));
    expect(fromResult[0]!.message).toMatchObject({ kind: "plan", text: "Do it" });
    expect(t2.finish({ stopReason: "stop" }).some((e) => e.type === "tool_end")).toBe(false);
  });

  it("marks tool calls cut off by Stop as stopped, rejected ones as rejected (I-190)", () => {
    const t = new ClaudeTranslator("p");
    t.message(assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sleep 9" } }, { type: "tool_use", id: "w1", name: "Write", input: { file_path: "a", content: "" } }]));
    t.rejectTool("w1");
    const ends = t.finish({ stopReason: "aborted" }).filter((e) => e.type === "tool_end");
    expect(ends.map((e) => e.type === "tool_end" && e.result)).toEqual([
      expect.objectContaining({ toolCallId: "b1", status: "error", stopped: true }),
      expect.objectContaining({ toolCallId: "w1", status: "error", rejected: true }),
    ]);
    expect(ends[1]!.type === "tool_end" && ends[1]!.result.stopped).toBeUndefined();
    // Stop while a call runs: Claude Code ends it with an error result before the turn ends.
    const cut = new ClaudeTranslator("s");
    cut.message(assistant("m1", [{ type: "tool_use", id: "b3", name: "Bash", input: { command: "find ." } }]));
    cut.stop();
    const [cutEnd] = cut.message(toolResult("b3", "The user doesn't want to proceed with this tool use.", undefined, true));
    expect(cutEnd).toMatchObject({ type: "tool_end", result: { status: "error", stopped: true } });
    const failed = new ClaudeTranslator("q");
    failed.message(assistant("m1", [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "x" } }]));
    const [end] = failed.finish({ stopReason: "error", errorMessage: "boom" }).filter((e) => e.type === "tool_end");
    // The run failed around it (budget, crash): it never ran, so it reads Stopped, not Failed.
    expect(end!.type === "tool_end" && end!.result).toMatchObject({ output: "Unfinished", stopped: true });
  });

  it("ignores a Task sub-agent's own messages", () => {
    const t = new ClaudeTranslator("p");
    expect(t.message(assistant("sub", [{ type: "text", text: "inner" }], undefined, { parent_tool_use_id: "task1" }))).toEqual([]);
    expect(t.message(stream({ type: "message_start", message: { id: "x" } }, "task1"))).toEqual([]);
  });

  it("settles unfinished tools and explains errors", () => {
    const t = new ClaudeTranslator("p");
    t.message(assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sleep 9" } }]));
    const events = t.finish({ stopReason: "aborted" });
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ result: { status: "error", output: "Stopped", stopped: true } });
    expect(events.find((e) => e.type === "message_end")).toMatchObject({ message: { stopReason: "aborted" } });

    const auth = new ClaudeTranslator("a");
    auth.message(assistant("m1", [{ type: "text", text: "Invalid API key · Please run /login" }], undefined, { error: "authentication_failed" }));
    const end = auth.finish({ stopReason: "stop" }).find((e) => e.type === "message_end") as { message: AssistantMessage };
    expect(end.message).toMatchObject({ stopReason: "error", errorMessage: expect.stringMatching(/isn't logged in/) });
    expect(friendlyError("Invalid API key · Please run /login")).toMatch(/Run `claude` in a terminal and log in/);
  });
});

describe("Claude models and thinking", () => {
  it("lists the SDK's models without its own 'default' entry, with thinking levels", () => {
    const models = translateClaudeModels(FAKE_INIT.models);
    expect(models.map((m) => [m.provider, m.id, m.name, m.description, m.group])).toEqual([
      ["anthropic", "sonnet", "Sonnet 5", "Efficient for routine tasks", "Claude Code"],
      ["anthropic", "haiku", "Haiku", undefined, "Claude Code"],
    ]);
    expect(models[0]!.thinkingLevels).toEqual(["off", "low", "medium", "high", "max"]);
    expect(claudeThinkingLevels(FAKE_INIT.models[2])).toEqual(["off", "low", "medium", "high"]);
  });

  it("names models with their version, like Claude Code's /model list (I-175)", () => {
    const label = (displayName: string, description?: string) => claudeModelLabel({ value: displayName.toLowerCase(), displayName, description });
    expect(label("Opus", "Opus 5.5 · Best for everyday, complex tasks")).toEqual({ name: "Opus 5.5", description: "Best for everyday, complex tasks" });
    expect(label("Fable", "Fable 5.1 · Most capable for your hardest work")).toEqual({ name: "Fable 5.1", description: "Most capable for your hardest work" });
    expect(label("Haiku", "Haiku 4.5 · Fastest for quick answers")).toEqual({ name: "Haiku 4.5", description: "Fastest for quick answers" });
    expect(label("Opus 4.8", "Newer version available · select Opus for Opus 5.5")).toEqual({ name: "Opus 4.8", description: "Newer version available · select Opus for Opus 5.5" });
    expect(label("Sonnet 5")).toEqual({ name: "Sonnet 5" });
    expect(label("Sonnet", "Sonnet 5")).toEqual({ name: "Sonnet 5" });
    expect(label("Opus", "Opus is the best model for long, careful agentic coding work")).toEqual({ name: "Opus", description: "Opus is the best model for long, careful agentic coding work" });
  });

  it("maps a thinking level to the query options", () => {
    const sonnet = FAKE_INIT.models[1];
    expect(thinkingOptions("off", sonnet)).toEqual({ thinking: { type: "disabled" } });
    expect(thinkingOptions("high", sonnet)).toEqual({ thinking: { type: "adaptive" }, effort: "high" });
    expect(thinkingOptions("medium", FAKE_INIT.models[2])).toEqual({ thinking: { type: "enabled", budgetTokens: 10_000 } });
  });
});

// ---------------------------------------------------------------------------------------------

describe("Claude sessions", () => {
  it("doesn't start Claude Code until the first prompt, then streams a reply", async () => {
    const sdk = new FakeClaudeSdk({ onUser: (q) => q.reply("Hello there!", { usage: { input_tokens: 1000, output_tokens: 20, cache_read_input_tokens: 3000 }, cost: 0.002 }) });
    const h = harness(sdk);
    const { session, events, run } = await openSession(h);
    expect(session.sessionRef).toMatch(/^[0-9a-f-]{36}$/);
    await flush(20);
    expect(sdk.chats).toHaveLength(0);

    await run("hello");
    const [query] = sdk.chats;
    expect(query!.options).toMatchObject({
      cwd,
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      sessionId: session.sessionRef,
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
    });
    expect(query!.options.resume).toBeUndefined();
    // The server's identity and nested-session markers never reach Claude Code.
    expect(query!.options.env).toMatchObject({ PATH: "/usr/bin", CLAUDE_AGENT_SDK_CLIENT_APP: "glade" });
    expect(query!.options.env).not.toHaveProperty("GLADE_TOKEN");
    expect(query!.options.env).not.toHaveProperty("CLAUDECODE");
    expect(query!.text()).toBe("hello");

    const transcript = await session.loadTranscript();
    expect(transcript.messages.map((m) => [m.role, messageText(m)])).toEqual([
      ["user", "hello"],
      ["assistant", "Hello there!"],
    ]);
    expect(events.filter((e) => e.type === "block_delta").map((e) => (e as { delta: string }).delta)).toEqual(["Hello ", "there!"]);
    expect(events[0]!.type).toBe("run_start");
    expect(events.at(-1)!.type).toBe("run_end");
    const state = session.getState();
    expect(state.isRunning).toBe(false);
    expect(state.model).toEqual({ provider: "anthropic", id: "sonnet" }); // adopted from init
    expect(state.contextUsage).toEqual({ tokens: 4020, contextWindow: 200_000, percent: (4020 / 200_000) * 100 });
    expect(state.sessionStats).toEqual({ cost: 0.002, tokens: { input: 20, output: 10, cacheRead: 5, cacheWrite: 0, total: 35 } });
    // Commands from the running process.
    expect(await session.listCommands()).toEqual([{ name: "review", description: "Review the changes", source: "extension", argsHint: "[focus]" }]);
  });

  it("sends images with the prompt", async () => {
    const sdk = new FakeClaudeSdk({ onUser: (q) => q.reply("A cat") });
    const { session } = await openSession(harness(sdk));
    await session.prompt({ text: "what is it?", images: [{ mimeType: "image/png", data: "AAAA" }] });
    await until(() => sdk.chats[0]?.received.length === 1);
    expect(sdk.chats[0]!.received[0]!.message.content).toEqual([
      { type: "text", text: "what is it?" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });

  it("resumes Claude's session when it has it, else starts it under the same id", async () => {
    const sessions = new Set(["11111111-1111-1111-1111-111111111111"]);
    const sdk = new FakeClaudeSdk({ sessions, onUser: (q) => q.reply("ok") });
    const h = harness(sdk);
    const known = await openSession(h, "11111111-1111-1111-1111-111111111111");
    await known.run("again");
    expect(sdk.chats[0]!.options).toMatchObject({ resume: "11111111-1111-1111-1111-111111111111" });
    expect(sdk.chats[0]!.options.sessionId).toBeUndefined();

    const unknown = await openSession(h, "22222222-2222-2222-2222-222222222222");
    await unknown.run("hi");
    expect(sdk.chats[1]!.options).toMatchObject({ sessionId: "22222222-2222-2222-2222-222222222222" });
    expect(sdk.chats[1]!.options.resume).toBeUndefined();
  });

  it("steers a running turn right away and holds follow-ups until it ends", async () => {
    let release!: () => void;
    const sdk = new FakeClaudeSdk({
      onUser: async (q, msg) => {
        const text = (msg.message.content as Array<{ text?: string }>)[0]?.text;
        if (text === "first") {
          await new Promise<void>((r) => (release = r));
          q.reply("done first");
        } else if (text === "later") q.reply("done later");
      },
    });
    const { session, events } = await openSession(harness(sdk));
    await session.prompt({ text: "first" });
    await until(() => sdk.chats[0]?.received.length === 1);
    await session.prompt({ text: "steer now", behavior: "steer" });
    await session.prompt({ text: "later", behavior: "followUp" });
    await until(() => sdk.chats[0]!.received.length === 2);
    expect(sdk.chats[0]!.text(1)).toBe("steer now");
    expect(session.getState().queue.followUp).toEqual(["later"]);
    release();
    await until(() => events.filter((e) => e.type === "run_end").length === 2);
    expect(sdk.chats[0]!.received.map((m) => (m.message.content as Array<{ text: string }>)[0]!.text)).toEqual(["first", "steer now", "later"]);
    const users = (await session.loadTranscript()).messages.filter((m) => m.role === "user").map(messageText);
    expect(users).toEqual(["first", "steer now", "later"]);
    expect(session.getState().queue.followUp).toEqual([]);
  });

  it("stays running while Claude Code reports more queued turns", async () => {
    const sdk = new FakeClaudeSdk({
      onUser: (q) => {
        q.emit(result({ queued: 1 }));
        q.reply("second turn");
      },
    });
    const { session, events } = await openSession(harness(sdk));
    await session.prompt({ text: "x" });
    await until(() => events.filter((e) => e.type === "run_end").length === 1);
    expect(events.filter((e) => e.type === "run_start")).toHaveLength(1);
    expect(assistants(await session.loadTranscript()).map(messageText)).toEqual(["second turn"]);
  });

  it("stops a turn with interrupt, and drops the process when no result comes", async () => {
    const sdk = new FakeClaudeSdk({
      onUser: (q) => q.emit(assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sleep 100" } }])),
      onInterrupt: (q) => {
        if (q === sdk.chats[0]) q.emit(result({ subtype: "error_during_execution", isError: true }));
      },
    });
    const h = harness(sdk);
    const { session, events } = await openSession(h);
    await session.prompt({ text: "go" });
    await until(() => events.some((e) => e.type === "tool_start"));
    await session.abort();
    await until(() => events.some((e) => e.type === "run_end"));
    expect(sdk.chats[0]!.interrupts).toBe(1);
    expect((await session.loadTranscript()).toolResults.b1).toMatchObject({ status: "error", output: "Stopped", stopped: true });
    expect(assistants(await session.loadTranscript())[0]!.stopReason).toBe("aborted");

    // A process that never answers the interrupt: the grace period ends the run and drops it.
    const silent = new FakeClaudeSdk({ onUser: (q) => q.emit(assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sleep 100" } }])) });
    const stuck = await openSession(harness(silent));
    await stuck.session.prompt({ text: "go" });
    await until(() => stuck.events.some((e) => e.type === "tool_start"));
    await stuck.session.abort();
    await until(() => stuck.events.some((e) => e.type === "run_end"), 2000);
    expect(silent.chats[0]!.closed).toBe(true);
    expect(stuck.exits).toEqual([]); // dropped on purpose, not a crash
  });

  it("reports a crash in the turn and exits the session", async () => {
    const sdk = new FakeClaudeSdk({ onUser: (q) => void setTimeout(() => q.end(new Error("Claude Code process exited with code 1")), 5) });
    const { session, exits, events } = await openSession(harness(sdk));
    await session.prompt({ text: "hi" });
    await until(() => exits.length === 1);
    expect(exits[0]!.message).toMatch(/Claude Code stopped: Claude Code process exited with code 1/);
    const reply = assistants(await session.loadTranscript())[0]!;
    expect(reply).toMatchObject({ stopReason: "error", errorMessage: expect.stringMatching(/exited with code 1/) });
    expect(events.at(-1)!.type).toBe("run_end");
  });

  it("says when Claude Code isn't logged in or isn't installed", async () => {
    const sdk = new FakeClaudeSdk({
      onUser: (q) => {
        q.emit(assistant("m1", [{ type: "text", text: "Invalid API key · Please run /login" }], undefined, { error: "authentication_failed" }));
        q.emit(result({ isError: true, text: "Invalid API key · Please run /login" }));
      },
    });
    const { session, run } = await openSession(harness(sdk));
    await run("hi");
    expect(assistants(await session.loadTranscript())[0]!.errorMessage).toMatch(/isn't logged in\. Run `claude` in a terminal/);

    const missing = await openSession(harness(new FakeClaudeSdk(), { findExecutable: () => null }));
    await missing.run("hi");
    expect(assistants(await missing.session.loadTranscript())[0]!.errorMessage).toMatch(/`claude` wasn't found on this device's PATH/);
  });

  it("asks for permission in Glade's card: allow once, always, reject", async () => {
    const answers: unknown[] = [];
    const sdk = new FakeClaudeSdk({
      onUser: async (q) => {
        q.emit(assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "rm -rf build" } }]));
        answers.push(await q.canUseTool("Bash", { command: "rm -rf build" }, "b1", { suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm:*" }], behavior: "allow", destination: "localSettings" }] }));
        answers.push(await q.canUseTool("Write", { file_path: "x.txt", content: "x" }, "w1"));
        q.emit(toolResult("w1", "The user rejected this tool call.", undefined, true));
        q.emit(result());
      },
    });
    const { session, events } = await openSession(harness(sdk));
    await session.prompt({ text: "clean" });
    const requests = () => events.filter((e): e is { type: "ui_request"; request: UiRequest } => e.type === "ui_request").map((e) => e.request);
    await until(() => requests().length === 1);
    const first = requests()[0]!;
    expect(first).toMatchObject({ kind: "permission", title: "Allow Bash?", message: "$ rm -rf build", toolCallId: "b1" });
    expect(first.kind === "permission" && first.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    session.respondToUi({ id: first.id, value: "allow_always" });
    await until(() => requests().length === 2);
    const second = requests()[1]!;
    // The Write call wasn't streamed yet: it's added so the card can point at it.
    expect(second).toMatchObject({ toolCallId: "w1", message: "x.txt" });
    expect(second.kind === "permission" && second.options.map((o) => o.id)).toEqual(["allow", "reject"]);
    session.respondToUi({ id: second.id, value: "reject" });
    await until(() => events.some((e) => e.type === "run_end"));
    expect(answers[0]).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf build" }, updatedPermissions: [expect.objectContaining({ type: "addRules" })] });
    expect(answers[1]).toMatchObject({ behavior: "deny" });
    expect((await session.loadTranscript()).toolResults.w1).toMatchObject({ status: "error", rejected: true, output: "" });
  });

  it("asks AskUserQuestion's questions as select dialogs", async () => {
    let answer: unknown;
    const sdk = new FakeClaudeSdk({
      onUser: async (q) => {
        answer = await q.canUseTool("AskUserQuestion", { questions: [{ question: "Which DB?", header: "DB", options: [{ label: "SQLite", description: "" }, { label: "Postgres", description: "" }] }] }, "q1");
        q.emit(result());
      },
    });
    const { session, events } = await openSession(harness(sdk));
    await session.prompt({ text: "set up" });
    await until(() => events.some((e) => e.type === "ui_request"));
    const request = (events.find((e) => e.type === "ui_request") as { request: UiRequest }).request;
    expect(request).toMatchObject({ kind: "select", title: "Which DB?", options: ["SQLite", "Postgres"] });
    session.respondToUi({ id: request.id, value: "Postgres" });
    await until(() => events.some((e) => e.type === "run_end"));
    expect(answer).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which DB?": "Postgres" } } });
  });

  it("closes pending permission cards when the run is stopped", async () => {
    let answer: unknown;
    const sdk = new FakeClaudeSdk({
      onUser: async (q) => {
        answer = await q.canUseTool("Bash", { command: "ls" }, "b1");
      },
      onInterrupt: (q) => q.emit(result({ subtype: "error_during_execution" })),
    });
    const { session, events } = await openSession(harness(sdk));
    await session.prompt({ text: "x" });
    await until(() => events.some((e) => e.type === "ui_request"));
    await session.abort();
    await until(() => answer !== undefined);
    expect(answer).toMatchObject({ behavior: "deny", interrupt: true });
    expect(events.some((e) => e.type === "ui_request_closed")).toBe(true);
  });

  it("applies model and thinking changes by restarting the idle process with the new options", async () => {
    const sdk = new FakeClaudeSdk({ onUser: (q) => q.reply("ok") });
    const h = harness(sdk);
    const session = (await h.openSession({ cwd, sessionRef: null, model: { provider: "anthropic", id: "haiku" }, thinkingLevel: "off" })) as ClaudeSession;
    open.push(session);
    expect(session.getState().thinkingLevels).toEqual(["off", "low", "medium", "high"]);
    const ends = () => sdk.chats.filter((q) => q.closed).length;
    await session.prompt({ text: "a" });
    await until(() => session.getState().sessionStats !== undefined);
    expect(sdk.chats[0]!.options).toMatchObject({ model: "haiku", thinking: { type: "disabled" } });

    await session.setModel({ provider: "anthropic", id: "sonnet" });
    expect(ends()).toBe(1); // idle: closed right away
    expect(session.getState().thinkingLevels).toEqual(["off", "low", "medium", "high", "max"]);
    await session.setThinkingLevel("max");
    await session.prompt({ text: "b" });
    await until(() => sdk.chats.length === 2 && sdk.chats[1]!.received.length === 1);
    expect(sdk.chats[1]!.options).toMatchObject({ model: "sonnet", thinking: { type: "adaptive" }, effort: "max", resume: session.sessionRef });
    await expect(session.setModel({ provider: "openai", id: "gpt-5" })).rejects.toThrow(/can't use openai\/gpt-5/);
  });

  it("compacts with /compact and reports the numbers", async () => {
    const sdk = new FakeClaudeSdk({
      onUser: (q, msg) => {
        const text = (msg.message.content as Array<{ text: string }>)[0]!.text;
        if (text.startsWith("/compact")) {
          q.emit({ type: "system", subtype: "status", status: "compacting" });
          q.emit({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 150_000, post_tokens: 32_000 } });
          q.emit({ type: "system", subtype: "status", status: null });
          q.emit(result());
        } else q.reply("ok");
      },
    });
    const { session, run, events } = await openSession(harness(sdk));
    await run("hi");
    const done = await session.compact("keep the API notes");
    expect(done).toEqual({ tokensBefore: 150_000, tokensAfter: 32_000 });
    expect(sdk.chats[0]!.text()).toBe("/compact keep the API notes");
    const notices = (await session.loadTranscript()).messages.filter((m): m is NoticeMessage => m.role === "notice");
    expect(notices.map((n) => [n.kind, n.text])).toEqual([["compaction", "Compacted context: 150k → 32k tokens"]]);
    expect(session.getState().isCompacting).toBe(false);
    expect(events.filter((e) => e.type === "run_start")).toHaveLength(1); // compaction isn't a run
  });

  it("holds messages sent during an idle /compact and sends them once it has finished, in order (I-216)", async () => {
    let finishCompact!: () => void;
    const sdk = new FakeClaudeSdk({
      onUser: async (q, msg) => {
        const text = (msg.message.content as Array<{ text: string }>)[0]!.text;
        if (text.startsWith("/compact")) {
          q.emit({ type: "system", subtype: "status", status: "compacting" });
          await new Promise<void>((r) => (finishCompact = r));
          q.emit({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 150_000, post_tokens: 32_000 } });
          q.emit({ type: "system", subtype: "status", status: null });
          q.emit(result());
        } else q.reply(`re: ${text}`);
      },
    });
    const { session, run, events } = await openSession(harness(sdk));
    await run("hi");
    const compacting = session.compact();
    await until(() => session.getState().isCompacting && !!finishCompact);
    // Neither a follow-up nor a steer starts a turn or reaches Claude Code before the compaction is over.
    await session.prompt({ text: "one", behavior: "followUp" });
    await session.prompt({ text: "two", behavior: "steer" });
    expect(session.getState().queue.followUp).toEqual(["one", "two"]);
    expect(sdk.chats[0]!.received).toHaveLength(2); // "hi" and "/compact"
    expect(events.filter((e) => e.type === "run_start")).toHaveLength(1);
    finishCompact();
    await compacting;
    await until(() => events.filter((e) => e.type === "run_end").length === 3, 3000);
    expect(sdk.chats[0]!.received.map((m) => (m.message.content as Array<{ text: string }>)[0]!.text)).toEqual(["hi", "/compact", "one", "two"]);
    expect(session.getState().queue.followUp).toEqual([]);
    const users = (await session.loadTranscript()).messages.filter((m) => m.role === "user").map(messageText);
    expect(users).toEqual(["hi", "one", "two"]);
  });
});

describe("Claude harness", () => {
  it("describes itself and lists models, the default model and folder commands from a probe", async () => {
    const sdk = new FakeClaudeSdk();
    const h = harness(sdk);
    expect(h.id).toBe("claude");
    expect(h.info.label).toBe("Claude Code");
    expect(CLAUDE_CAPABILITIES).toMatchObject({ models: true, steering: true, compact: true, uiRequests: true, subagents: true, shell: false });
    expect((await h.listModels()).map((m) => m.id)).toEqual(["sonnet", "haiku"]);
    expect(await h.getDefaults()).toEqual({ model: { provider: "anthropic", id: "sonnet" }, thinkingLevel: null });
    expect(await h.listFolderCommands(cwd)).toEqual([{ name: "review", description: "Review the changes", source: "extension", argsHint: "[focus]" }]);
    // One probe per folder (cached), each closed after answering; nothing persisted.
    expect(sdk.queries).toHaveLength(2);
    expect(sdk.queries.every((q) => q.closed && q.options.persistSession === false)).toBe(true);

    const missing = harness(new FakeClaudeSdk(), { which: () => false });
    expect(missing.isInstalled()).toBe(false);
    expect(await missing.listModels()).toEqual([]);
  });

  it("lists Claude Code's own default model first, so new chats don't start on the priciest", async () => {
    const sdk = new FakeClaudeSdk();
    sdk.init = {
      ...FAKE_INIT,
      models: [
        { value: "default", displayName: "Default (recommended)", resolvedModel: "claude-sonnet-5" },
        { value: "opus", displayName: "Opus", resolvedModel: "claude-opus-5" },
        FAKE_INIT.models[1]!,
        FAKE_INIT.models[2]!,
      ],
    };
    expect((await harness(sdk).listModels()).map((m) => m.id)).toEqual(["sonnet", "opus", "haiku"]);
  });

  it("names chats with Haiku, no tools, nothing saved", async () => {
    const sdk = new FakeClaudeSdk({ onString: (q) => q.emit(assistant("t", [{ type: "text", text: '"Fix the login bug."' }]), result()) });
    const h = harness(sdk);
    expect(await h.generateTitle({ firstMessage: "the login is broken", cwd, model: { provider: "anthropic", id: "opus" } })).toBe("Fix the login bug");
    expect(sdk.queries[0]!.options).toMatchObject({ model: "haiku", tools: [], maxTurns: 1, persistSession: false, thinking: { type: "disabled" } });
    expect(String(sdk.queries[0]!.params.prompt)).toContain("the login is broken");
  });

  it("answers side questions with streamed text", async () => {
    const sdk = new FakeClaudeSdk({
      onString: (q) =>
        q.emit(
          stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Yes, " } }),
          stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "it is." } }),
          assistant("s", [{ type: "text", text: "Yes, it is." }]),
          result(),
        ),
    });
    const deltas: string[] = [];
    const answer = await harness(sdk).answerSideQuestion({ prompt: "…", systemPrompt: "Answer.", model: null, cwd, signal: new AbortController().signal, onDelta: (d) => deltas.push(d) });
    expect(answer).toEqual({ answer: "Yes, it is." });
    expect(deltas).toEqual(["Yes, ", "it is."]);
  });

  it("gives chats Glade's sub-agent and chat tools through an in-process MCP server", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ agent: { name: "scout", displayName: "Leo" } }), { status: 200 });
    }) as typeof fetch;
    const env = { GLADE_URL: "http://127.0.0.1:1", GLADE_TOKEN: "tok", GLADE_SESSION_ID: "s1" };
    const main = gladeToolSpecs({ env, subagents: true, cwd, fetch: fetchImpl });
    expect(main.map((t) => t.name)).toEqual(["spawn_agent", "message_agent", "list_agents", "close_agent", "find_chats", "read_chat", "open_chat"]);
    expect(gladeToolSpecs({ env, subagents: false, cwd }).map((t) => t.name)).toEqual(["find_chats", "read_chat", "open_chat"]);
    expect(gladeToolSpecs({ env: { ...env, GLADE_AGENT_NAME: "scout" }, subagents: true, cwd }).map((t) => t.name)).toEqual(["report_done", "message_agent", "find_chats", "read_chat", "open_chat"]);
    expect(gladeToolSpecs({ env: {}, subagents: true, cwd })).toEqual([]);
    const spawn = main[0]!;
    expect(spawn.description).toContain("Use spawn_agent only when");
    const out = await spawn.handler({ name: "scout", task: "Look around" });
    expect(calls[0]).toEqual({ url: "http://127.0.0.1:1/api/agents/spawn", body: expect.objectContaining({ name: "scout", task: "Look around" }) });
    expect(out.content[0]!.text).toMatch(/Spawned Leo \("scout"\)/);

    // A chat's process gets them as the "glade" MCP server; its identity isn't in the process env.
    const sdk = new FakeClaudeSdk({ onUser: (q) => q.reply("ok") });
    const { run } = await openSession(harness(sdk), null, env);
    await run("hi");
    expect(sdk.servers.map((s) => [s.name, s.tools.length])).toEqual([["glade", 7]]);
    expect(sdk.chats[0]!.options.mcpServers).toHaveProperty("glade");
    // Glade's own tools never ask for permission (a sub-agent's report_done would block otherwise).
    expect(sdk.chats[0]!.options.allowedTools).toEqual(["mcp__glade"]);
    expect(sdk.chats[0]!.options.env).not.toHaveProperty("GLADE_TOKEN");
    expect(claudeToolAllowlist(["read", "bash", "find", "Grep", "spawn_agent", "mcp__docs__x"])).toEqual(["Read", "Bash", "Glob", "Grep", "mcp__docs__x"]);
  });

  it("runs a sub-agent as its Glade agent definition: agents + agent, role prompt appended, Glade's tools allowed (I-218)", async () => {
    const sdk = new FakeClaudeSdk({ onUser: (q) => q.reply("ok") });
    const env = { GLADE_URL: "http://127.0.0.1:1", GLADE_TOKEN: "tok", GLADE_SESSION_ID: "s1", GLADE_AGENT_NAME: "auth-scout" };
    const agentDefinition = {
      name: "scout",
      description: "Fast read-only search.",
      prompt: "Cite file:line.",
      rolePrompt: "# agent-teams: you are a sub-agent",
      tools: ["Read", "Grep", "mcp__docs__search"],
      disallowedTools: ["WebFetch"],
      permissionMode: "plan",
      sandbox: null,
      // I-221: a native model/effort never reaches the SDK's AgentDefinition (the chat's model stays).
      native: { claude: { maxTurns: 3, skills: ["lint"], hooks: { Stop: [] }, model: "opus", effort: "high" } },
    };
    const session = (await harness(sdk).openSession({ cwd, sessionRef: null, env, tools: ["Read", "Grep", "mcp__docs__search", "report_done", "message_agent"], appendSystemPrompt: "role + def", agentDefinition })) as ClaudeSession;
    open.push(session);
    expect(session.getState().permissionMode).toBe("plan");
    await session.prompt({ text: "go" });
    await until(() => sdk.chats.length === 1);
    const options = sdk.chats[0]!.options;
    expect(options.agent).toBe("scout");
    expect(options.agents).toEqual({
      scout: {
        description: "Fast read-only search.",
        prompt: `Cite file:line.\n\nYou are working in ${cwd}.`,
        tools: ["Read", "Grep", "mcp__docs__search", "mcp__glade__report_done", "mcp__glade__message_agent", "mcp__glade__find_chats", "mcp__glade__read_chat", "mcp__glade__open_chat"],
        disallowedTools: ["WebFetch"],
        maxTurns: 3,
        skills: ["lint"],
      },
    });
    // The role prompt alone (the definition's prompt is the agent's own); built-in tools only in `tools`.
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "# agent-teams: you are a sub-agent" });
    expect(options.tools).toEqual(["Read", "Grep"]);
    expect(options.disallowedTools).toEqual(["WebFetch"]);
    expect(options.permissionMode).toBe("plan");
  });

  it("a definition without a prompt keeps Claude Code's prompt (no agent; tools still apply)", async () => {
    const sdk = new FakeClaudeSdk({ onUser: (q) => q.reply("ok") });
    const agentDefinition = { name: "lite", description: "", prompt: "", rolePrompt: "role", tools: ["Read"], disallowedTools: null, permissionMode: null, sandbox: null };
    const session = (await harness(sdk).openSession({ cwd, sessionRef: null, tools: ["Read", "report_done"], appendSystemPrompt: "role", agentDefinition })) as ClaudeSession;
    open.push(session);
    await session.prompt({ text: "go" });
    await until(() => sdk.chats.length === 1);
    expect(sdk.chats[0]!.options).toMatchObject({ tools: ["Read"], systemPrompt: { append: "role" } });
    expect(sdk.chats[0]!.options.agent).toBeUndefined();
  });

  it("reports the first init's tools and MCP servers; main sessions list the spawnable agents (I-218)", async () => {
    const sdk = new FakeClaudeSdk({
      onUser: (q) => {
        q.emit({ type: "system", subtype: "init", model: "claude-sonnet-5", session_id: "s", tools: ["Read", "Bash", "mcp__docs__search"], mcp_servers: [{ name: "docs", status: "connected" }] });
        q.reply("ok");
      },
    });
    const reported: unknown[] = [];
    const env = { GLADE_URL: "http://127.0.0.1:1", GLADE_TOKEN: "tok", GLADE_SESSION_ID: "s1" };
    const list = { agents: [{ name: "scout", description: "Looks.", harness: "codex", harnessLabel: "Codex", model: null, readOnly: true }], harnesses: [] };
    const session = (await harness(sdk).openSession({ cwd, sessionRef: null, env, onTools: (t, m) => reported.push([t, m]), spawnableAgents: async () => list })) as ClaudeSession;
    open.push(session);
    await session.prompt({ text: "go" });
    await until(() => reported.length === 1);
    expect(reported).toEqual([[["Read", "Bash", "mcp__docs__search"], ["docs"]]]);
    const spawn = sdk.servers[0]!.tools.find((t) => t.name === "spawn_agent")!;
    expect(spawn.description).toContain("- scout (Codex, read-only): Looks.");
  });

  it("deletes Claude's session file with the chat", async () => {
    const sdk = new FakeClaudeSdk();
    await harness(sdk).deleteSession("33333333-3333-3333-3333-333333333333");
    expect(sdk.deleted).toEqual(["33333333-3333-3333-3333-333333333333"]);
  });
});

describe("Claude's own sub-agents (I-188)", () => {
  const TASK = { type: "tool_use", id: "task1", name: "Task", input: { description: "Count files", prompt: "Count the files in src", subagent_type: "Explore" } };
  /** The sub-agent's own traffic: streamed thinking + text, a Bash call and its result, its last reply. */
  function subagentWork(q: import("./fixtures/fake-claude-sdk.js").FakeQuery, parent = "task1", report = "There are 3 files.") {
    q.emit(
      stream({ type: "message_start", message: { id: `${parent}-s1` } }, parent),
      stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, parent),
      stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Listing." } }, parent),
      stream({ type: "content_block_stop", index: 0 }, parent),
      assistant(`${parent}-s1`, [{ type: "thinking", thinking: "Listing.", signature: "x" }], undefined, { parent_tool_use_id: parent }),
      assistant(`${parent}-s1`, [{ type: "tool_use", id: `${parent}-b1`, name: "Bash", input: { command: "ls src | wc -l" } }], undefined, { parent_tool_use_id: parent }),
      subToolResult(parent, `${parent}-b1`, "3"),
      assistant(`${parent}-s2`, [{ type: "text", text: report }], undefined, { parent_tool_use_id: parent }),
    );
  }

  it("mirrors a foreground Task sub-agent: its stream in its own tab, its report from the Task result", async () => {
    const sdk = new FakeClaudeSdk({
      onUser: (q) => {
        q.emit({ type: "system", subtype: "init", model: "claude-sonnet-5", session_id: "s" }, assistant("m1", [TASK]));
        q.emit({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "task1", description: "Count files", subagent_type: "Explore", task_type: "local_agent", is_backgrounded: false });
        subagentWork(q);
        q.emit(toolResult("task1", [{ type: "text", text: "There are 3 files.\nagentId: t1" }], { status: "completed", content: [{ type: "text", text: "There are 3 files." }], agentId: "t1", prompt: "Count the files in src" }));
        q.emit({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "task1", status: "completed", summary: "done", output_file: "" });
        q.reply("It has 3 files.");
      },
    });
    const { session, run, events } = await openSession(harness(sdk));
    const natives: NativeSubagentEvent[] = [];
    session.onNativeSubagent((e) => natives.push(e));
    await run("count the files with a sub-agent");
    expect(sdk.chats[0]!.options.forwardSubagentText).toBe(true);
    expect(natives[0]).toEqual({ type: "native_subagent_start", id: "task1", toolCallId: "task1", name: "Explore", title: "Count files", task: "Count the files in src" });
    const child = natives.flatMap((e) => (e.type === "native_subagent_event" ? [e.event] : [])).reduce(foldEvent, { messages: [], toolResults: {} } as Transcript);
    expect(assistants(child).map((m) => m.content.map((b) => b.type))).toEqual([["thinking", "toolCall"], ["text"]]);
    expect(child.toolResults["task1-b1"]).toMatchObject({ status: "done", output: "3" });
    expect(natives.filter((e) => e.type === "native_subagent_end")).toEqual([{ type: "native_subagent_end", id: "task1", status: "done", result: "There are 3 files." }]);
    // The parent shows the Task call (linked) and its own reply, not the sub-agent's messages.
    const parent = events.reduce(foldEvent, { messages: [], toolResults: {} } as Transcript);
    expect(assistants(parent).map((m) => messageText(m))).toEqual(["", "It has 3 files."]);
    expect(assistants(parent)[0]!.content[0]).toMatchObject({ id: "task1", kind: "task" });
  });

  it("keeps a background sub-agent after the turn, ends it with task_notification, and Stop stops it", async () => {
    let query: import("./fixtures/fake-claude-sdk.js").FakeQuery | null = null;
    const sdk = new FakeClaudeSdk({
      onUser: (q, msg) => {
        query = q;
        if (JSON.stringify(msg.message.content).includes("stop")) return;
        q.emit(assistant("m1", [TASK, { ...TASK, id: "task2" }]));
        q.emit({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "task1", description: "Count files", task_type: "local_agent", is_backgrounded: true });
        q.emit({ type: "system", subtype: "task_started", task_id: "t2", tool_use_id: "task2", description: "Count files", task_type: "local_agent", is_backgrounded: true });
        q.emit(toolResult("task1", "Async agent launched", { status: "async_launched", agentId: "t1", description: "Count files", prompt: "x", outputFile: "/tmp/o" }));
        q.emit(toolResult("task2", "Async agent launched", { status: "async_launched", agentId: "t2", description: "Count files", prompt: "x", outputFile: "/tmp/o" }));
        q.reply("Started two agents.");
      },
      onStopTask: (q, taskId) => q.emit({ type: "system", subtype: "task_notification", task_id: taskId, status: "stopped", summary: "", output_file: "" }),
    });
    const { session, run } = await openSession(harness(sdk));
    const natives: NativeSubagentEvent[] = [];
    session.onNativeSubagent((e) => natives.push(e));
    await run("two background agents");
    expect(natives.filter((e) => e.type === "native_subagent_start").map((e) => e.id)).toEqual(["task1", "task2"]);
    expect(natives.some((e) => e.type === "native_subagent_end")).toBe(false); // the turn's end doesn't end them
    subagentWork(query!, "task1", "Three.");
    query!.emit({ type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "task1", status: "completed", summary: "Agent finished", output_file: "" });
    await until(() => natives.some((e) => e.type === "native_subagent_end"));
    expect(natives.find((e) => e.type === "native_subagent_end")).toEqual({ type: "native_subagent_end", id: "task1", status: "done", result: "Three." });
    // Stop: the parent is idle, the other agent still runs → stopTask.
    await session.abort();
    await until(() => natives.filter((e) => e.type === "native_subagent_end").length === 2);
    expect(query!.stoppedTasks).toEqual(["t2"]);
    expect(natives.at(-1)).toEqual({ type: "native_subagent_end", id: "task2", status: "stopped" });
    // Stop from its tab: stopNativeSubagent (nothing left to stop here).
    await session.stopNativeSubagent("task2");
    expect(query!.stoppedTasks).toEqual(["t2"]);
  });

  it("ends a foreground sub-agent as stopped when the turn is stopped; its permission card asks in the parent", async () => {
    let query: import("./fixtures/fake-claude-sdk.js").FakeQuery | null = null;
    const sdk = new FakeClaudeSdk({
      onUser: (q) => {
        query = q;
        q.emit(assistant("m1", [TASK]));
        q.emit({ type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "task1", description: "Count files", task_type: "local_agent" });
        q.emit(assistant("s1", [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "a.txt", content: "x" } }], undefined, { parent_tool_use_id: "task1" }));
        void q.canUseTool("Write", { file_path: "a.txt", content: "x" }, "w1", { agentID: "t1" });
      },
      onInterrupt: (q) => q.emit(result({ subtype: "error_during_execution" })),
    });
    const { session, events } = await openSession(harness(sdk));
    const natives: NativeSubagentEvent[] = [];
    session.onNativeSubagent((e) => natives.push(e));
    await session.prompt({ text: "go" });
    await until(() => events.some((e) => e.type === "ui_request"));
    const card = events.find((e): e is Extract<AgentEvent, { type: "ui_request" }> => e.type === "ui_request")!.request;
    expect(card).toMatchObject({ kind: "permission", toolCallId: "w1" });
    // The Write call is the sub-agent's, not the parent's.
    const parent = events.reduce(foldEvent, { messages: [], toolResults: {} } as Transcript);
    expect(assistants(parent).flatMap((m) => m.content).map((b) => (b.type === "toolCall" ? b.id : b.type))).toEqual(["task1"]);
    await session.abort();
    await until(() => natives.some((e) => e.type === "native_subagent_end"));
    expect(query!.interrupts).toBe(1);
    expect(natives.find((e) => e.type === "native_subagent_end")).toMatchObject({ id: "task1", status: "stopped" });
  });

  it("becomes a read-only sub-agent tab of the chat through the app service", async () => {
    const sdk = new FakeClaudeSdk({
      onUser: (q) => {
        q.emit(assistant("m1", [TASK]));
        subagentWork(q);
        q.emit(toolResult("task1", "There are 3 files."));
        q.reply("Done.");
      },
    });
    const store = new Store(join(dir, "data"), 0);
    const service = new AppService({ store, harnesses: new HarnessRegistry([harness(sdk)]), scratchDir: cwd });
    try {
      const created = await service.createWorkspace({ projectId: null, harness: "claude", prompt: "count" });
      const wid = created.workspace.id;
      await until(() => service.listSessions(wid).some((s) => s.agent?.status === "done") && !service.listSessions(wid)[0]!.running);
      const child = service.listSessions(wid).find((s) => s.kind === "subagent")!;
      expect(child).toMatchObject({ parentSessionId: created.session.session.id, agentName: "explore", title: "Count files", harness: "claude", agent: { native: "Claude Code", result: "There are 3 files." } });
      expect(store.loadTranscript(child.id).messages.map((m) => [m.role, messageText(m)])).toEqual([
        ["user", "Count the files in src"],
        ["assistant", ""],
        ["assistant", "There are 3 files."],
      ]);
      await expect(service.prompt(child.id, { text: "more" })).rejects.toMatchObject({ status: 409 });
      expect(sdk.chats).toHaveLength(1);
    } finally {
      await service.dispose();
    }
  });
});

describe("Claude chats through the app service", () => {
  it("creates a Claude Code chat, streams it into the store and lists both agents' models", async () => {
    const sdk = new FakeClaudeSdk({
      onUser: async (q) => {
        q.emit(assistant("m1", [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "README.md" } }]));
        const answer = await q.canUseTool("Read", { file_path: "README.md" }, "r1");
        q.emit(toolResult("r1", answer && (answer as { behavior: string }).behavior === "allow" ? "# Readme" : "denied"));
        q.reply("It's a readme.");
      },
    });
    const store = new Store(join(dir, "data"), 0);
    const registry = new HarnessRegistry([new FakeHarness(undefined, 0, { id: "pi" }), harness(sdk)]);
    const service = new AppService({ store, harnesses: registry, scratchDir: cwd });
    try {
      expect(service.listHarnesses().map((h) => h.id)).toEqual(["pi", "claude"]);
      const models = await service.listModels();
      expect(models.filter((m) => m.harness === "claude").map((m) => m.id)).toEqual(["sonnet", "haiku"]);
      expect(models[0]!.harness).toBe("pi"); // the default agent's first

      const created = await service.createWorkspace({ projectId: null, harness: "claude", prompt: "what is this?" });
      const id = created.session.session.id;
      expect(created.session.session.harness).toBe("claude");
      await until(() => service.listSessions(created.workspace.id)[0]!.pendingInputs === 1, 2000);
      const detail = await service.getSessionDetail(id);
      const request = detail.pendingUiRequests[0]!;
      expect(request).toMatchObject({ kind: "permission", toolCallId: "r1" });
      service.respondToUi(id, { id: request.id, value: "allow" });
      await until(() => !service.listSessions(created.workspace.id)[0]!.running && store.loadTranscript(id).messages.length >= 3, 2000);
      const stored = store.loadTranscript(id);
      expect(stored.messages.map((m) => [m.role, messageText(m)])).toEqual([
        ["user", "what is this?"],
        ["assistant", ""],
        ["assistant", "It's a readme."],
      ]);
      expect(Object.values(stored.toolResults)[0]).toMatchObject({ status: "done", output: "# Readme" });
      // The session ref is Claude's session id, kept for resuming.
      expect(store.getSession(id)!.sessionRef).toBe(sdk.chats[0]!.options.sessionId);
      expect(store.getSession(id)!.model).toEqual({ provider: "anthropic", id: "sonnet" });
    } finally {
      await service.dispose();
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("Claude permissions like the CLI (I-174)", () => {
  const rules = (toolName: string, ...contents: string[]) => ({ type: "addRules", rules: contents.map((ruleContent) => ({ toolName, ruleContent })), behavior: "allow", destination: "localSettings" });
  const label = (...suggestions: unknown[]) => alwaysAllowLabel(suggestions, "/Users/me/src/app", "/Users/me");

  it("words the 'don't ask again' option like Claude Code", () => {
    expect(label(rules("Bash", "npm test:*"))).toBe("Yes, and don't ask again for npm test commands in ~/src/app");
    expect(label(rules("Bash", "npm test *", "git status:*"))).toBe("Yes, and don't ask again for npm test and git status commands in ~/src/app");
    expect(label(rules("Bash", "a:*", "b:*", "c:*"))).toBe("Yes, and don't ask again for a, b, and c commands in ~/src/app");
    expect(label(rules("WebFetch", "domain:example.com"))).toBe("Yes, and don't ask again for example.com");
    expect(label({ type: "addDirectories", directories: ["/Users/me/data"], destination: "session" })).toBe("Yes, and always allow access to ~/data from this project");
    expect(label({ type: "setMode", mode: "acceptEdits", destination: "session" })).toBe("Yes, allow all edits during this session");
    expect(label({ type: "addDirectories", directories: ["/tmp/x"], destination: "session" }, rules("Bash", "ls:*"))).toBe("Yes, and allow access to /tmp/x and ls commands");
    expect(label({ type: "setMode", mode: "acceptEdits", destination: "session" }, { type: "addDirectories", directories: ["/tmp/x"], destination: "session" })).toBe(
      "Yes, allow all edits during this session; always allow access to /tmp/x from this project",
    );
    expect(label({ ...rules("Read", "//tmp/notes/**"), destination: "session" })).toBe("Yes, allow reading from /tmp/notes during this session");
    expect(label({ type: "addRules", rules: [{ toolName: "mcp__github__create_issue" }], behavior: "allow", destination: "localSettings" })).toBe("Yes, and don't ask again for mcp__github__create_issue");
    expect(label()).toBeNull();
    expect(alwaysAllowLabel(undefined, "/x")).toBeNull();
  });

  it("offers Default, Accept edits, Plan, Auto (models that support it) and Bypass, in Shift+Tab order", () => {
    expect(claudePermissionModes({ supportsAutoMode: true }).map((m) => m.id)).toEqual(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
    expect(claudePermissionModes(undefined).map((m) => m.id)).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    expect(claudePermissionModes(undefined).at(-1)).toMatchObject({ label: "Bypass permissions", danger: true });
    expect(claudePermissionModes(undefined, { bypassDisabled: true, current: "dontAsk" }).map((m) => m.id)).toEqual(["default", "acceptEdits", "plan", "dontAsk"]);
  });

  it("reads the default mode and the bypass switch from Claude Code's settings files", () => {
    const user = join(dir, "user.json");
    const local = join(dir, "local.json");
    writeFileSync(user, JSON.stringify({ permissions: { defaultMode: "plan" } }));
    writeFileSync(local, JSON.stringify({ permissions: { defaultMode: "acceptEdits", disableBypassPermissionsMode: "disable" } }));
    expect(readClaudePermissionSettings(cwd, [user, join(dir, "missing.json")])).toEqual({ defaultMode: "plan", bypassDisabled: false });
    expect(readClaudePermissionSettings(cwd, [user, local])).toEqual({ defaultMode: "acceptEdits", bypassDisabled: true });
    writeFileSync(local, "{ not json");
    expect(readClaudePermissionSettings(cwd, [local])).toEqual({ defaultMode: null, bypassDisabled: false });
  });

  const requestsOf = (events: AgentEvent[]) => events.filter((e): e is { type: "ui_request"; request: UiRequest } => e.type === "ui_request").map((e) => e.request);

  it("asks with Claude Code's options; No stops the turn and waits for the user", async () => {
    let answer: unknown;
    const sdk = new FakeClaudeSdk({
      onUser: async (q) => {
        q.emit(assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test" } }]));
        answer = await q.canUseTool("Bash", { command: "npm test" }, "b1", { suggestions: [rules("Bash", "npm test:*")] });
        q.emit(result({ subtype: "error_during_execution", isError: true }));
      },
    });
    const { session, events } = await openSession(harness(sdk));
    await session.prompt({ text: "test it" });
    await until(() => requestsOf(events).length === 1);
    const request = requestsOf(events)[0]!;
    expect(request.kind === "permission" && request.numbered).toBe(true);
    expect(request.kind === "permission" && request.options).toEqual([
      { id: "allow", label: "Yes", kind: "allow_once" },
      { id: "allow_always", label: `Yes, and don't ask again for npm test commands in ${cwd}`, kind: "allow_always" },
      { id: "reject", label: "No, and tell Claude what to do differently", kind: "reject_once", focusComposer: true },
    ]);
    session.respondToUi({ id: request.id, value: "reject" });
    await until(() => events.some((e) => e.type === "run_end"));
    expect(answer).toMatchObject({ behavior: "deny", interrupt: true, message: expect.stringMatching(/STOP what you are doing and wait for the user/) });
    const reply = assistants(await session.loadTranscript())[0]!;
    expect(reply.stopReason).toBe("aborted"); // stopped, not failed
    expect(reply.errorMessage).toBeUndefined();
    expect((await session.loadTranscript()).toolResults.b1).toMatchObject({ rejected: true });
  });

  it("leaves out 'don't ask again' when Claude Code says so, and opens on No when it must", async () => {
    const sdk = new FakeClaudeSdk({
      onUser: async (q) => {
        await q.canUseTool("Bash", { command: "rm -rf /" }, "b1", { suggestions: [rules("Bash", "rm:*")], suppressAlwaysAllowRule: true, defaultToNo: true });
        q.emit(result());
      },
    });
    const { session, events } = await openSession(harness(sdk));
    await session.prompt({ text: "x" });
    await until(() => requestsOf(events).length === 1);
    const request = requestsOf(events)[0]!;
    expect(request.kind === "permission" && request.options.map((o) => o.id)).toEqual(["allow", "reject"]);
    expect(request).toMatchObject({ defaultOptionId: "reject" });
    session.respondToUi({ id: request.id, value: "allow" });
    await until(() => events.some((e) => e.type === "run_end"));
  });

  it("'Yes, allow all edits during this session' switches the chat to Accept edits", async () => {
    let answer: unknown;
    const sdk = new FakeClaudeSdk({
      onUser: async (q) => {
        answer = await q.canUseTool("Write", { file_path: "a.txt", content: "a" }, "w1", { suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
        q.emit(result());
      },
    });
    const { session, events } = await openSession(harness(sdk));
    expect(session.getState().permissionMode).toBe("default");
    await session.prompt({ text: "write" });
    await until(() => requestsOf(events).length === 1);
    const request = requestsOf(events)[0]!;
    expect(request.kind === "permission" && request.options[1]!.label).toBe("Yes, allow all edits during this session");
    session.respondToUi({ id: request.id, value: "allow_always" });
    await until(() => events.some((e) => e.type === "run_end"));
    expect(answer).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "acceptEdits" }] });
    expect(session.getState().permissionMode).toBe("acceptEdits");
  });

  it("asks to approve a plan like the CLI: the plan card, then Ready to code? switching the mode (I-189)", async () => {
    const answers: unknown[] = [];
    const sdk = new FakeClaudeSdk({
      onUser: async (q) => {
        q.emit(assistant(`m${answers.length}`, [{ type: "tool_use", id: `x${answers.length}`, name: "ExitPlanMode", input: { plan: "1. Add --version" } }]));
        answers.push(await q.canUseTool("ExitPlanMode", { plan: "1. Add --version" }, `x${answers.length}`));
        q.emit(result());
      },
    });
    const session = (await harness(sdk).openSession({ cwd, sessionRef: null, permissionMode: "plan", model: { provider: "anthropic", id: "haiku" } })) as ClaudeSession;
    open.push(session);
    const events: AgentEvent[] = [];
    session.onEvent((e) => events.push(e));

    // "No, keep planning": denied like the CLI's No, the turn ends Stopped, still in Plan mode.
    await session.prompt({ text: "plan a --version flag" });
    await until(() => requestsOf(events).length === 1);
    const first = requestsOf(events)[0]!;
    expect(first).toMatchObject({ kind: "permission", title: "Ready to code?", numbered: true, defaultOptionId: "plan_accept_edits" });
    expect(first.kind === "permission" && first.options).toEqual([
      { id: "plan_accept_edits", label: "Yes, auto-accept edits", kind: "allow_always" },
      { id: "plan_default", label: "Yes, manually approve edits", kind: "allow_once" },
      { id: "plan_keep", label: "No, keep planning", kind: "reject_once", focusComposer: true },
    ]);
    const transcript = await session.loadTranscript();
    const plans = transcript.messages.filter((m) => m.role === "notice" && m.kind === "plan");
    expect(plans).toMatchObject([{ text: "1. Add --version" }]);
    expect(Object.keys(transcript.toolResults)).toEqual([]); // no tool row for ExitPlanMode
    session.respondToUi({ id: first.id, value: "plan_keep" });
    await until(() => events.filter((e) => e.type === "run_end").length === 1);
    expect(answers[0]).toMatchObject({ behavior: "deny", interrupt: true, message: expect.stringMatching(/STOP what you are doing/) });
    expect(session.getState().permissionMode).toBe("plan");
    expect(assistants(await session.loadTranscript()).at(-1)!.stopReason).toBe("aborted");

    // "Yes, auto-accept edits": allowed with a setMode update, the pill follows.
    await session.prompt({ text: "shorter" });
    await until(() => requestsOf(events).length === 2);
    session.respondToUi({ id: requestsOf(events)[1]!.id, value: "plan_accept_edits" });
    await until(() => events.filter((e) => e.type === "run_end").length === 2);
    expect(answers[1]).toEqual({ behavior: "allow", updatedInput: { plan: "1. Add --version" }, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });
    expect(session.getState().permissionMode).toBe("acceptEdits");

    // "Yes, manually approve edits": Default.
    await session.setPermissionMode("plan");
    await session.prompt({ text: "again" });
    await until(() => requestsOf(events).length === 3);
    session.respondToUi({ id: requestsOf(events)[2]!.id, value: "plan_default" });
    await until(() => events.filter((e) => e.type === "run_end").length === 3);
    expect(answers[2]).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "default" }] });
    expect(session.getState().permissionMode).toBe("default");
  });

  it("offers Auto on plan approval where the model has it, and reads the plan file when the input has no plan", async () => {
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, "From the file");
    let answer: unknown;
    const sdk = new FakeClaudeSdk({
      onUser: async (q) => {
        answer = await q.canUseTool("ExitPlanMode", { planFilePath: planFile }, "x1");
        q.emit(result());
      },
    });
    const { session, events } = await openSession(harness(sdk)); // Claude Code's default model: Auto mode
    await session.prompt({ text: "plan" });
    await until(() => requestsOf(events).length === 1);
    const request = requestsOf(events)[0]!;
    expect(request.kind === "permission" && request.options[0]).toEqual({ id: "plan_auto", label: "Yes, and use auto mode", kind: "allow_always" });
    expect((await session.loadTranscript()).messages.some((m) => m.role === "notice" && m.kind === "plan" && m.text === "From the file")).toBe(true);
    session.respondToUi({ id: request.id, value: "plan_auto" });
    await until(() => events.some((e) => e.type === "run_end"));
    expect(answer).toMatchObject({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "auto" }] });
    expect(session.getState().permissionMode).toBe("auto");
  });

  it("starts a new chat in Claude Code's own default mode, bypass selectable", async () => {
    const sdk = new FakeClaudeSdk({ onUser: (q) => q.reply("ok") });
    const h = harness(sdk, { permissionSettings: () => ({ defaultMode: "acceptEdits", bypassDisabled: false }) });
    const { session, run } = await openSession(h);
    expect(session.getState().permissionMode).toBe("acceptEdits");
    // Claude Code's default model (Sonnet) supports auto mode.
    expect(session.getState().permissionModes!.map((m) => m.id)).toEqual(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
    await run("hi");
    expect(sdk.chats[0]!.options.permissionMode).toBeUndefined(); // Claude Code applies its own default
    expect(sdk.chats[0]!.options.allowDangerouslySkipPermissions).toBe(true);

    // Bypass turned off in Claude Code's settings: not offered, not allowed.
    const off = harness(new FakeClaudeSdk({ onUser: (q) => q.reply("ok") }), { permissionSettings: () => ({ defaultMode: null, bypassDisabled: true }) });
    const locked = await openSession(off);
    expect(locked.session.getState().permissionModes!.map((m) => m.id)).not.toContain("bypassPermissions");
    await expect(locked.session.setPermissionMode("bypassPermissions")).rejects.toThrow(/can't switch/);
  });

  it("tells the new-chat composer its modes and default without a chat, and starts in the picked mode (I-184)", async () => {
    const sdk = new FakeClaudeSdk({ onUser: (q) => q.reply("ok") });
    const h = harness(sdk, { permissionSettings: () => ({ defaultMode: "acceptEdits", bypassDisabled: false }) });
    // Claude Code's default model (Sonnet) has Auto; Haiku doesn't.
    expect(await h.getPermissionModes(cwd, null)).toEqual({
      modes: expect.arrayContaining([expect.objectContaining({ id: "auto" })]),
      defaultMode: "acceptEdits",
    });
    const haiku = await h.getPermissionModes(cwd, { provider: "anthropic", id: "haiku" });
    expect(haiku.modes.map((m) => m.id)).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    const locked = harness(sdk, { permissionSettings: () => ({ defaultMode: null, bypassDisabled: true }) });
    expect(await locked.getPermissionModes(cwd, { provider: "anthropic", id: "haiku" })).toEqual({
      modes: [expect.objectContaining({ id: "default" }), expect.objectContaining({ id: "acceptEdits" }), expect.objectContaining({ id: "plan" })],
      defaultMode: "default",
    });
    expect(await harness(sdk, { which: () => false }).getPermissionModes(cwd, null)).toEqual({ modes: [], defaultMode: null });

    // A new chat started in Plan: its first process runs in Plan (not Claude Code's default).
    const session = (await h.openSession({ cwd, sessionRef: null, permissionMode: "plan" })) as ClaudeSession;
    open.push(session);
    expect(session.getState().permissionMode).toBe("plan");
    await session.prompt({ text: "plan it" });
    await until(() => sdk.chats[0]?.received.length === 1);
    expect(sdk.chats[0]!.options.permissionMode).toBe("plan");
  });

  it("switches modes mid-run, keeps the mode when Claude Code refuses, and passes a saved mode to new processes", async () => {
    let release!: () => void;
    const sdk = new FakeClaudeSdk({
      onUser: async (q) => {
        await new Promise<void>((r) => (release = r));
        q.reply("ok");
      },
      onSetPermissionMode: (_q, mode) => {
        if (mode === "auto") throw new Error("auto mode is unavailable for your plan");
      },
    });
    const h = harness(sdk);
    const session = (await h.openSession({ cwd, sessionRef: null, model: { provider: "anthropic", id: "haiku" } })) as ClaudeSession;
    open.push(session);
    const events: AgentEvent[] = [];
    session.onEvent((e) => events.push(e));
    // Haiku: no Auto.
    expect(session.getState().permissionModes!.map((m) => m.id)).toEqual(["default", "acceptEdits", "plan", "bypassPermissions"]);
    await session.setPermissionMode("plan"); // no process yet: used when it starts
    await session.prompt({ text: "go" });
    await until(() => sdk.chats[0]?.received.length === 1);
    expect(sdk.chats[0]!.options).toMatchObject({ permissionMode: "plan", allowDangerouslySkipPermissions: true });

    await session.setPermissionMode("bypassPermissions");
    expect(sdk.chats[0]!.modes).toEqual(["bypassPermissions"]);
    expect(session.getState().permissionMode).toBe("bypassPermissions");
    await session.setModel({ provider: "anthropic", id: "sonnet" }); // auto becomes available
    await expect(session.setPermissionMode("auto")).rejects.toThrow(/didn't switch to Auto mode: auto mode is unavailable/);
    expect(session.getState().permissionMode).toBe("bypassPermissions");
    release();
    await until(() => events.some((e) => e.type === "run_end"));
    await until(() => sdk.chats[0]!.closed); // model change: restarted when idle

    // Claude Code reports a mode itself (a plan approved): the chat follows.
    sdk.chats[0]!.emit({ type: "system", subtype: "status", status: null, permissionMode: "default" });

    // A reopened chat keeps its saved mode.
    const reopened = (await h.openSession({ cwd, sessionRef: session.sessionRef, permissionMode: "acceptEdits" })) as ClaudeSession;
    open.push(reopened);
    expect(reopened.getState().permissionMode).toBe("acceptEdits");
    await reopened.prompt({ text: "again" });
    await until(() => sdk.chats.length === 2 && sdk.chats[1]!.received.length === 1);
    expect(sdk.chats[1]!.options.permissionMode).toBe("acceptEdits");
  });

  it("follows the mode Claude Code reports", async () => {
    const sdk = new FakeClaudeSdk({
      onUser: (q) => {
        q.emit({ type: "system", subtype: "init", model: "claude-sonnet-5", permissionMode: "plan", session_id: "s" });
        q.emit({ type: "system", subtype: "status", status: null, permissionMode: "acceptEdits", session_id: "s" });
        q.reply("ok");
      },
    });
    const { session, run } = await openSession(harness(sdk));
    await run("hi");
    expect(session.getState().permissionMode).toBe("acceptEdits");
  });

  it("saves the mode per chat, so a resume keeps it and a new chat doesn't inherit it", async () => {
    const sdk = new FakeClaudeSdk({ onUser: (q) => q.reply("ok") });
    const store = new Store(join(dir, "data"), 0);
    const registry = new HarnessRegistry([new FakeHarness(undefined, 0, { id: "pi" }), harness(sdk)]);
    const service = new AppService({ store, harnesses: registry, scratchDir: cwd });
    try {
      expect(service.listHarnesses().find((h) => h.id === "claude")!.capabilities.permissionModes).toBe(true);
      const first = await service.createWorkspace({ projectId: null, harness: "claude" });
      const id = first.session.session.id;
      expect((await service.getSessionDetail(id)).state.permissionMode).toBe("default");
      await service.setPermissionMode(id, "bypassPermissions");
      await until(() => store.getSession(id)!.permissionMode === "bypassPermissions");
      await expect(service.setPermissionMode(id, "nonsense")).rejects.toThrow(/can't switch/);

      const second = await service.createWorkspace({ projectId: null, harness: "claude" });
      expect((await service.getSessionDetail(second.session.session.id)).state.permissionMode).toBe("default");
      expect(store.getSession(second.session.session.id)!.permissionMode).toBeUndefined();
    } finally {
      await service.dispose();
    }
  });
});

function foldEvent(t: Transcript, e: AgentEvent): Transcript {
  return applyAgentEvent(t, e);
}
