/**
 * I-173: Claude Code as a native harness, against a scripted fake of the Claude Agent SDK
 * (`fixtures/fake-claude-sdk.ts`; never the real CLI or a model). Covers the translator (streaming,
 * tools, diffs, plans, errors), sessions (start, resume, steer/follow-up, stop, crash, sign-in,
 * permissions, questions, model/thinking, compaction), the harness (models, commands, titles,
 * Glade's tools) and a chat through the app service.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAgentEvent, messageText, type AgentEvent, type AssistantMessage, type NoticeMessage, type Transcript, type UiRequest } from "@glade/protocol";
import { ClaudeHarness, CLAUDE_CAPABILITIES } from "../src/harness/claude/claude-harness.js";
import type { ClaudeSession } from "../src/harness/claude/claude-session.js";
import { friendlyError } from "../src/harness/claude/claude-session.js";
import { claudeToolAllowlist, gladeToolSpecs } from "../src/harness/claude/glade-tools.js";
import { claudeThinkingLevels, thinkingOptions, translateClaudeModels } from "../src/harness/claude/models.js";
import { claudeToolBlock, structuredPatchDiff } from "../src/harness/claude/tools.js";
import { ClaudeTranslator } from "../src/harness/claude/translate.js";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { AppService } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";
import { FAKE_INIT, FakeClaudeSdk, assistant, result, stream, toolResult } from "./fixtures/fake-claude-sdk.js";
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
    session: { cancelGraceMs: 50 },
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

  it("ignores a Task sub-agent's own messages", () => {
    const t = new ClaudeTranslator("p");
    expect(t.message(assistant("sub", [{ type: "text", text: "inner" }], undefined, { parent_tool_use_id: "task1" }))).toEqual([]);
    expect(t.message(stream({ type: "message_start", message: { id: "x" } }, "task1"))).toEqual([]);
  });

  it("settles unfinished tools and explains errors", () => {
    const t = new ClaudeTranslator("p");
    t.message(assistant("m1", [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "sleep 9" } }]));
    const events = t.finish({ stopReason: "aborted" });
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ result: { status: "error", output: "Stopped" } });
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
    expect(models.map((m) => [m.provider, m.id, m.name])).toEqual([
      ["anthropic", "sonnet", "Sonnet"],
      ["anthropic", "haiku", "Haiku"],
    ]);
    expect(models[0]!.thinkingLevels).toEqual(["off", "low", "medium", "high", "max"]);
    expect(claudeThinkingLevels(FAKE_INIT.models[2])).toEqual(["off", "low", "medium", "high"]);
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
    expect((await session.loadTranscript()).toolResults.b1).toMatchObject({ status: "error", output: "Stopped" });
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
    expect(sdk.chats[0]!.options.env).not.toHaveProperty("GLADE_TOKEN");
    expect(claudeToolAllowlist(["read", "bash", "find", "Grep", "spawn_agent"])).toEqual(["Read", "Bash", "Glob", "Grep"]);
  });

  it("deletes Claude's session file with the chat", async () => {
    const sdk = new FakeClaudeSdk();
    await harness(sdk).deleteSession("33333333-3333-3333-3333-333333333333");
    expect(sdk.deleted).toEqual(["33333333-3333-3333-3333-333333333333"]);
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

function foldEvent(t: Transcript, e: AgentEvent): Transcript {
  return applyAgentEvent(t, e);
}
