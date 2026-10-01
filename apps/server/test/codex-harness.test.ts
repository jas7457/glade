/**
 * I-177: Codex as a native harness over the `codex app-server` protocol, against a scripted fake
 * app-server (`fixtures/fake-codex-app-server.ts`; never the real CLI or a model). Covers the
 * translator (streaming, tools, diffs, plan), models, errors and limits (the real usage-limit
 * payloads), permissions, sessions (threads, turns, steer/follow-up, stop, approvals, questions,
 * Glade's tools, compaction, crashes), the harness and a chat through the app service, plus the
 * JSONL framing against a real child process. I-178: skills and /review in the slash menu, skill
 * items, reviews as the reply, and `!cmd` / `!!cmd` via `command/exec`. I-186: Plan mode (Codex's
 * collaboration mode), the proposed plan card and "Implement this plan?". I-185: `skills/changed`
 * tells open chats their commands changed.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAgentEvent, messageText, type AgentEvent, type AssistantMessage, type NoticeMessage, type Transcript, type UiRequest } from "@glade/protocol";
import { CODEX_CAPABILITIES, CodexHarness } from "../src/harness/codex/codex-harness.js";
import { taskNameTitle, type CodexSession } from "../src/harness/codex/codex-session.js";
import { NOT_INSTALLED, NOT_LOGGED_IN, codexUsageLimits, formatReset, friendlyTurnError, usageLimitMessage } from "../src/harness/codex/errors.js";
import { codexThinkingLevels, effortToLevel, translateCodexModels } from "../src/harness/codex/models.js";
import { codexPermissionModes, commandApproval, commandDecision, modeFromConfig, turnPermissions } from "../src/harness/codex/permissions.js";
import type { ThreadItem } from "../src/harness/codex/protocol.js";
import { CodexRpc, spawnCodexTransport } from "../src/harness/codex/rpc.js";
import { codexDiff, displayCommand } from "../src/harness/codex/tools.js";
import { CodexTranslator } from "../src/harness/codex/translate.js";
import { codexSlashCommands, parseSlashText, reviewTarget, shellArgv, skillInput, userShellRecord, SHELL_RECORD_MAX_CHARS } from "../src/harness/codex/commands.js";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import type { NativeSubagentEvent } from "../src/harness/types.js";
import { AppService } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";
import { FAKE_MODELS, FAKE_SKILLS, FakeCodexAppServer, type FakeTurn, LIMIT_REACHED, USAGE_LIMIT_ERROR, type FakeCodexOptions } from "./fixtures/fake-codex-app-server.js";
import { until } from "./helpers.js";

let dir: string;
let cwd: string;
const open: CodexSession[] = [];
const harnesses: CodexHarness[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glade-codex-"));
  cwd = join(dir, "project");
  mkdirSync(cwd);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.dispose()));
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
  rmSync(dir, { recursive: true, force: true });
});

function harness(codex: FakeCodexAppServer, extra: Partial<ConstructorParameters<typeof CodexHarness>[0]> = {}): CodexHarness {
  const h = new CodexHarness({
    utilityCwd: dir,
    connect: () => codex.connect(),
    which: () => true,
    findExecutable: () => "/usr/local/bin/codex",
    env: { PATH: "/usr/bin", HOME: "/Users/me", GLADE_TOKEN: "server-secret", CODEX_SANDBOX: "seatbelt", CODEX_HOME: "/Users/me/.codex" },
    session: { cancelGraceMs: 50 },
    ...extra,
  });
  harnesses.push(h);
  return h;
}

async function openSession(h: CodexHarness, sessionRef: string | null = null, extra: { env?: Record<string, string>; permissionMode?: string } = {}) {
  const session = (await h.openSession({ cwd, sessionRef, ...extra })) as CodexSession;
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
  const transcript = () => events.reduce(applyAgentEvent, { messages: [], toolResults: {} } as Transcript);
  const uiRequests = () => events.filter((e): e is Extract<AgentEvent, { type: "ui_request" }> => e.type === "ui_request").map((e) => e.request);
  return { session, events, exits, run, transcript, uiRequests };
}

const assistants = (t: Transcript) => t.messages.filter((m): m is AssistantMessage => m.role === "assistant");
const fold = (events: AgentEvent[]) => events.reduce(applyAgentEvent, { messages: [], toolResults: {} } as Transcript);

// ---------------------------------------------------------------------------------------------

describe("Codex translator", () => {
  it("reads a command cut off by Stop as stopped, not failed (I-190)", () => {
    const t = new CodexTranslator("p", () => 1);
    const cmd = (status: "inProgress" | "failed" | "declined", id: string): ThreadItem => ({ type: "commandExecution", id, command: "sleep 9", cwd: "/p", status, commandActions: [], aggregatedOutput: "", exitCode: null, durationMs: null });
    t.itemStarted(cmd("inProgress", "c1"));
    t.itemStarted(cmd("inProgress", "c2"));
    const before = t.itemCompleted(cmd("failed", "c1"));
    expect(before.find((e) => e.type === "tool_end")).toMatchObject({ result: { status: "error" } });
    expect((before.find((e) => e.type === "tool_end") as { result: { stopped?: boolean } }).result.stopped).toBeUndefined();
    t.stop();
    expect(t.itemCompleted(cmd("declined", "c2")).find((e) => e.type === "tool_end")).toEqual(expect.objectContaining({ result: expect.objectContaining({ status: "error", stopped: true }) }));
  });

  it("streams reasoning and text, and opens the next message after a tool call", () => {
    const t = new CodexTranslator("p", () => 1);
    const events = [
      ...t.itemStarted({ type: "reasoning", id: "r1", summary: [], content: [] }),
      ...t.reasoningSummaryDelta("r1", "Look", 0),
      ...t.reasoningSummaryDelta("r1", " around", 0),
      ...t.reasoningSummaryDelta("r1", "Then act", 1),
      ...t.reasoningTextDelta("r1", "raw (ignored: there's a summary)"),
      ...t.itemCompleted({ type: "reasoning", id: "r1", summary: ["Look around", "Then act"], content: [] }),
      ...t.itemStarted({ type: "reasoning", id: "r2", summary: [], content: [] }),
      ...t.itemCompleted({ type: "reasoning", id: "r2", summary: [], content: [] }), // empty: nothing shown
      ...t.itemStarted({ type: "commandExecution", id: "c1", command: "ls", cwd: "/p", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null }),
      ...t.itemCompleted({ type: "commandExecution", id: "c1", command: "ls", cwd: "/p", status: "completed", commandActions: [], aggregatedOutput: "a\nb\n", exitCode: 0, durationMs: 3 }),
      ...t.itemStarted({ type: "agentMessage", id: "m1", text: "" }),
      ...t.agentDelta("m1", "Two "),
      ...t.agentDelta("m1", "files."),
      ...t.itemCompleted({ type: "agentMessage", id: "m1", text: "Two files." }),
      ...t.finish({ stopReason: "stop" }),
    ];
    const transcript = fold(events);
    const [first, second] = assistants(transcript);
    expect(first!.content.map((b) => b.type)).toEqual(["thinking", "toolCall"]);
    expect(first!.content[0]).toEqual({ type: "thinking", text: "Look around\n\nThen act" });
    expect(first!.stopReason).toBe("toolUse");
    expect(second!.content).toEqual([{ type: "text", text: "Two files." }]);
    expect(second!.stopReason).toBe("stop");
    expect(transcript.toolResults.c1).toMatchObject({ status: "done", output: "a\nb\n" });
  });

  it("streams command output and reports failures with the exit code; parsed reads show as reads", () => {
    const t = new CodexTranslator("p");
    const cmd = (status: "inProgress" | "failed", extra: Partial<Extract<ThreadItem, { type: "commandExecution" }>> = {}): ThreadItem => ({
      type: "commandExecution",
      id: "c1",
      command: "npm test",
      cwd: "/p",
      status,
      commandActions: [{ type: "unknown", command: "npm test" }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      ...extra,
    });
    const events = [...t.itemStarted(cmd("inProgress")), ...t.commandOutput("c1", "FAIL x"), ...t.commandOutput("c1", "\n")];
    expect(events.filter((e) => e.type === "tool_update").at(-1)).toMatchObject({ result: { status: "running", output: "FAIL x\n" } });
    events.push(...t.itemCompleted(cmd("failed", { aggregatedOutput: "FAIL x\n", exitCode: 1 })));
    const transcript = fold(events);
    expect(assistants(transcript)[0]!.content[0]).toMatchObject({ type: "toolCall", kind: "shell", input: { command: "npm test" } });
    expect(transcript.toolResults.c1).toMatchObject({ status: "error", output: "FAIL x\nExit code 1" });

    const read = fold([...events, ...t.itemStarted({ type: "commandExecution", id: "c2", command: "cat a.ts", cwd: "/p", status: "inProgress", commandActions: [{ type: "read", command: "cat a.ts", name: "a.ts", path: "/p/a.ts" }], aggregatedOutput: null, exitCode: null, durationMs: null })]);
    expect(assistants(read)[0]!.content[1]).toMatchObject({ kind: "read", input: { path: "/p/a.ts" } });
  });

  it("shows a file change as one call per file with its diff", () => {
    const t = new CodexTranslator("p");
    const item: ThreadItem = {
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [
        { path: "src/a.ts", kind: { type: "update", move_path: null }, diff: "@@ -2,3 +2,3 @@\n keep\n-old\n+new\n keep2\n" },
        { path: "notes.md", kind: { type: "add" }, diff: "hello\nworld\n" },
      ],
    };
    const transcript = fold([...t.itemStarted({ ...item, status: "inProgress" }), ...t.itemCompleted(item), ...t.finish({ stopReason: "stop" })]);
    const blocks = assistants(transcript)[0]!.content;
    expect(blocks).toMatchObject([
      { type: "toolCall", id: "f1", kind: "edit", input: { path: "src/a.ts" } },
      { type: "toolCall", id: "f1#1", kind: "write", input: { path: "notes.md", content: "hello\nworld\n" } },
    ]);
    expect(transcript.toolResults.f1!.diff).toEqual([
      { type: "gap", text: "" },
      { type: "context", text: "keep", oldLine: 2, newLine: 2 },
      { type: "del", text: "old", oldLine: 3 },
      { type: "add", text: "new", newLine: 3 },
      { type: "context", text: "keep2", oldLine: 4, newLine: 4 },
    ]);
    expect(transcript.toolResults["f1#1"]!.diff).toEqual([
      { type: "add", text: "hello", newLine: 1 },
      { type: "add", text: "world", newLine: 2 },
    ]);
    expect(codexDiff({ path: "x", kind: { type: "delete" }, diff: "gone\n" })).toEqual([{ type: "del", text: "gone", oldLine: 1 }]);
  });

  it("maps MCP calls, web searches (query known at the end), Glade's tools and Codex's sub-agents", () => {
    const t = new CodexTranslator("p");
    const events = [
      ...t.itemStarted({ type: "mcpToolCall", id: "m", server: "docs", tool: "search", status: "inProgress", arguments: { q: "x" }, result: null, error: null }),
      ...t.itemCompleted({ type: "mcpToolCall", id: "m", server: "docs", tool: "search", status: "completed", arguments: { q: "x" }, result: { content: [{ type: "text", text: "found" }], structuredContent: null }, error: null }),
      ...t.itemStarted({ type: "webSearch", id: "w", query: "", action: null }),
      ...t.itemCompleted({ type: "webSearch", id: "w", query: "codex app-server", action: { type: "search", query: "codex app-server", queries: null } }),
      ...t.itemStarted({ type: "dynamicToolCall", id: "d", namespace: null, tool: "spawn_agent", arguments: { name: "scout", task: "Look" }, status: "inProgress", contentItems: null, success: null }),
      ...t.itemCompleted({ type: "dynamicToolCall", id: "d", namespace: null, tool: "spawn_agent", arguments: { name: "scout", task: "Look" }, status: "completed", contentItems: [{ type: "inputText", text: "Spawned" }], success: true }),
      ...t.itemStarted({ type: "collabAgentToolCall", id: "s", tool: "spawnAgent", status: "inProgress", prompt: "Check the tests\nthoroughly" }),
      ...t.itemCompleted({ type: "collabAgentToolCall", id: "s", tool: "spawnAgent", status: "completed", prompt: "Check the tests\nthoroughly", agentsStates: { thr: { status: "completed", message: "All green." } } }),
      // I-179: GPT-6's multi-agent v2 reports sub-agents as activity items.
      ...t.itemStarted({ type: "subAgentActivity", id: "v", kind: "started", agentThreadId: "thr-child", agentPath: "/root/tiny" }),
      ...t.itemCompleted({ type: "subAgentActivity", id: "v", kind: "started", agentThreadId: "thr-child", agentPath: "/root/tiny" }),
      ...t.itemCompleted({ type: "subAgentActivity", id: "v2", kind: "completed", agentThreadId: "thr-child", agentPath: "/root/tiny" }),
    ];
    const transcript = fold(events);
    expect(assistants(transcript)[0]!.content).toMatchObject([
      { name: "mcp__docs__search", kind: "mcp", input: { server: "docs", tool: "search" } },
      { name: "web_search", kind: "web", input: { query: "codex app-server" } },
      { name: "spawn_agent", kind: "task", input: { agentName: "scout" } },
      { kind: "task", input: { description: "Check the tests" } },
      { name: "spawn_agent", kind: "task", input: { description: "Codex sub-agent /root/tiny" } },
    ]);
    expect(transcript.toolResults.s).toMatchObject({ status: "done", output: "All green." });
    expect(transcript.toolResults.v).toMatchObject({ status: "done", output: "Started Codex sub-agent /root/tiny" });
    expect(transcript.toolResults.m).toMatchObject({ status: "done", output: "found" });
    expect(transcript.toolResults.d).toMatchObject({ status: "done", output: "Spawned" });
  });

  it("keeps one plan card per turn, updated in place", () => {
    const t = new CodexTranslator("p");
    const transcript = fold([
      ...t.plan([{ step: "Read", status: "inProgress" }, { step: "Fix", status: "pending" }], "Two steps"),
      ...t.plan([{ step: "Read", status: "completed" }, { step: "Fix", status: "inProgress" }]),
    ]);
    const plans = transcript.messages.filter((m): m is NoticeMessage => m.role === "notice" && m.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]!.plan).toEqual([
      { content: "Read", status: "completed" },
      { content: "Fix", status: "in_progress" },
    ]);
  });

  it("settles unfinished tools and carries the turn's error", () => {
    const t = new CodexTranslator("p");
    const transcript = fold([
      ...t.itemStarted({ type: "commandExecution", id: "c", command: "sleep 9", cwd: "/p", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null }),
      ...t.finish({ stopReason: "aborted" }),
      ...t.finish({ stopReason: "error", errorMessage: "Codex usage limit reached — resets Oct 13", errorDetails: "You've hit your usage limit." }),
    ]);
    expect(transcript.toolResults.c).toMatchObject({ status: "error", output: "Stopped", stopped: true });
    const last = assistants(transcript).at(-1)!;
    expect(last).toMatchObject({ stopReason: "error", errorMessage: "Codex usage limit reached — resets Oct 13", errorDetails: "You've hit your usage limit." });
  });
});

describe("Codex models, limits and permissions", () => {
  it("lists visible models under 'Codex', the configured one first, efforts as thinking levels", () => {
    const models = translateCodexModels(FAKE_MODELS, "gpt-5.6-terra");
    expect(models.map((m) => [m.provider, m.id, m.name, m.group])).toEqual([
      ["codex", "gpt-5.6-terra", "GPT-5.6-Terra", "Codex"],
      ["codex", "gpt-6-luna", "GPT-6-Luna", "Codex"],
    ]);
    expect(models[0]!.description).toBe("Older balanced model for straightforward work.");
    // Codex's `ultra` has no Glade level; `none` is off.
    expect(models[0]!.thinkingLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortToLevel("none")).toBe("off");
    expect(effortToLevel("ultra")).toBeNull();
    expect(codexThinkingLevels(undefined)).toEqual(["low", "medium", "high"]);
  });

  it("says when the usage limit is reached and when it resets (the real payloads)", () => {
    const now = new Date("2026-09-29T18:00:00Z");
    const resetDay = new Date(1791922639 * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    expect(resetDay).toMatch(/^Oct 1[34]$/);
    expect(usageLimitMessage(LIMIT_REACHED.rateLimits, now)).toBe(`Codex usage limit reached — resets ${resetDay}`);
    const friendly = friendlyTurnError(USAGE_LIMIT_ERROR, LIMIT_REACHED, now);
    expect(friendly.message).toBe(`Codex usage limit reached — resets ${resetDay}`);
    expect(friendly.details).toContain("Upgrade to Plus");
    expect(friendlyTurnError({ message: "401", codexErrorInfo: "unauthorized", additionalDetails: null }, null).message).toBe(NOT_LOGGED_IN);
    expect(friendlyTurnError({ message: "boom", codexErrorInfo: "other", additionalDetails: null }, null)).toEqual({ message: "boom" });
    // Within a day: the time.
    expect(formatReset(new Date(now.getTime() + 3600_000), now)).toMatch(/^at \d/);
  });

  it("turns Codex's rate limits into the usage gauge", () => {
    const usage = codexUsageLimits(LIMIT_REACHED, 5);
    expect(usage).toMatchObject({ source: "Codex (free)", provider: "codex", fetchedAt: 5, stale: false });
    expect(usage.limits).toEqual([{ id: "primary", label: "This month", percent: 100, resetsAt: "2026-10-13T20:17:19.000Z", severity: "critical", active: true }]);
  });

  it("offers Codex's presets as permission modes and words the card like Codex", () => {
    expect(codexPermissionModes().map((m) => [m.id, m.label, !!m.danger])).toEqual([
      ["read-only", "Read only", false],
      ["auto", "Auto", false],
      ["plan", "Plan mode", false],
      ["full-access", "Full access", true],
    ]);
    expect(turnPermissions("full-access")).toEqual({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    expect(turnPermissions("read-only")).toEqual({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly", networkAccess: false } });
    expect(modeFromConfig({ sandbox_mode: "danger-full-access", approval_policy: "never" })).toBe("full-access");
    expect(modeFromConfig({ sandbox_mode: "read-only" })).toBe("read-only");
    expect(modeFromConfig(null)).toBe("auto");

    const params = { threadId: "t", turnId: "u", itemId: "c", command: "npm test", proposedExecpolicyAmendment: ["npm", "test"] };
    const card = commandApproval(params);
    expect(card.title).toBe("Would you like to run the following command?");
    expect(card.message).toBe("$ npm test");
    expect(card.options.map((o) => o.label)).toEqual(["Yes, proceed", "Yes, and don't ask again for commands that start with `npm test`", "No, and tell Codex what to do differently"]);
    expect(commandDecision("accept_always", params)).toEqual({ acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } });
    expect(commandDecision("accept_always", { ...params, proposedExecpolicyAmendment: null })).toBe("acceptForSession");
    expect(commandDecision(null, params)).toBe("cancel");
    // I-179: the login-shell wrapper Codex runs commands in isn't shown.
    expect(commandApproval({ ...params, command: "/bin/zsh -lc 'curl -sI https://example.com | head -1'" }).message).toBe("$ curl -sI https://example.com | head -1");
  });

  it("shows commands without Codex's login-shell wrapper (I-179)", () => {
    expect(displayCommand("/bin/zsh -lc 'sleep 12'")).toBe("sleep 12");
    expect(displayCommand(String.raw`bash -c 'echo '\''hi'\'''`)).toBe("echo 'hi'");
    expect(displayCommand(String.raw`/bin/zsh -lc "printf '\\nTested\\n' >> README.md"`)).toBe(String.raw`printf '\nTested\n' >> README.md`);
    expect(displayCommand(String.raw`/bin/zsh -lc "echo \"a\" \$HOME"`)).toBe('echo "a" $HOME');
    expect(displayCommand("npm test")).toBe("npm test");
    expect(displayCommand("/bin/zsh -lc 'a' 'b'")).toBe("/bin/zsh -lc 'a' 'b'");
    const t = new CodexTranslator("p");
    const events = t.itemStarted({ type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'ls -la'", cwd: "/p", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null });
    expect(assistants(fold(events))[0]!.content[0]).toMatchObject({ kind: "shell", input: { command: "ls -la" }, args: { command: "/bin/zsh -lc 'ls -la'" } });
  });
});

// ---------------------------------------------------------------------------------------------

describe("Codex sessions", () => {
  it("starts a thread when a new chat opens, then streams a turn with the chat's settings", async () => {
    const codex = new FakeCodexAppServer({ onTurn: (t) => t.reply("Hello there") });
    const h = harness(codex);
    const { session, run, transcript } = await openSession(h);
    expect(session.sessionRef).toBe([...codex.threads.keys()][0]);
    expect(codex.sent("thread/start")[0]).toMatchObject({ cwd, approvalPolicy: "on-request", sandbox: "workspace-write", model: "gpt-6-luna" });
    // I-179: Codex's own sub-agents are off (their spawn_agent shadowed Glade's).
    expect(codex.sent("thread/start")[0]!.config).toEqual({ "features.multi_agent": false });
    expect(codex.sent("turn/start")).toHaveLength(0);
    expect(session.getState()).toMatchObject({ model: { provider: "codex", id: "gpt-6-luna" }, thinkingLevel: "medium", permissionMode: "auto" });

    await run("hi");
    expect(codex.sent("turn/start")[0]).toMatchObject({
      threadId: session.sessionRef,
      input: [{ type: "text", text: "hi", text_elements: [] }],
      model: "gpt-6-luna",
      effort: "medium",
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
    });
    expect(transcript().messages.map((m) => [m.role, messageText(m)])).toEqual([
      ["user", "hi"],
      ["assistant", "Hello there"],
    ]);
    expect(session.getState().contextUsage).toMatchObject({ tokens: 5000, contextWindow: 272000 });
    expect(session.getState().sessionStats!.tokens).toMatchObject({ total: 10000, cacheRead: 1000 });
    expect(session.getState().isRunning).toBe(false);
    // Glade's own and a parent Codex session's variables stay out of the app-server.
    expect(h.childEnv()).toEqual({ PATH: "/usr/bin", HOME: "/Users/me", CODEX_HOME: "/Users/me/.codex" });
  });

  it("resumes a saved thread; one Codex no longer has starts fresh", async () => {
    const codex = new FakeCodexAppServer({ onTurn: (t) => t.reply("ok") });
    codex.addThread("thr-saved");
    const h = harness(codex);
    const { session, run } = await openSession(h, "thr-saved");
    expect(codex.sent("thread/resume")[0]).toMatchObject({ threadId: "thr-saved", excludeTurns: true, cwd, config: { "features.multi_agent": false } });
    expect(session.sessionRef).toBe("thr-saved");
    await run("again");
    expect(codex.sent("turn/start")[0]!.threadId).toBe("thr-saved");

    const gone = await openSession(h, "thr-gone");
    expect(gone.session.sessionRef).not.toBe("thr-gone");
    expect(codex.sent("thread/start")).toHaveLength(1);
  });

  it("ends a turn refused by the usage limit with the reset date, then resumes the unloaded thread", async () => {
    let n = 0;
    const codex = new FakeCodexAppServer({
      onTurn: (t) => {
        if (n++ > 0) return t.reply("back");
        codex.options.rateLimits = LIMIT_REACHED; // the limit is hit during this turn
        t.fail(USAGE_LIMIT_ERROR);
      },
    });
    const { run, transcript, session } = await openSession(harness(codex));
    await run("hi");
    const failed = assistants(transcript()).at(-1)!;
    expect(failed.errorMessage).toMatch(/^Codex usage limit reached — resets Oct 1[34]$/);
    expect(failed.errorDetails).toContain("try again at Oct 13th");
    expect(codex.sent("turn/start")).toHaveLength(1);

    // Still used up: the chat says so without sending a turn.
    await run("again");
    expect(assistants(transcript()).at(-1)!).toMatchObject({ errorMessage: failed.errorMessage, errorDetails: expect.stringContaining("nothing was sent") });
    expect(codex.sent("turn/start")).toHaveLength(1);

    // Reset: Codex unloaded the thread after the failure, so the next turn resumes it first.
    codex.options.rateLimits = undefined;
    await run("and now");
    expect(codex.sent("thread/resume")).toEqual([expect.objectContaining({ threadId: session.sessionRef })]);
    expect(messageText(assistants(transcript()).at(-1)!)).toBe("back");
  });

  it("says when Codex isn't logged in or isn't installed", async () => {
    const codex = new FakeCodexAppServer({ account: { account: null, requiresOpenaiAuth: true } });
    const { run, transcript } = await openSession(harness(codex));
    await run("hi");
    expect(assistants(transcript()).at(-1)!.errorMessage).toBe(NOT_LOGGED_IN);
    expect(codex.sent("turn/start")).toHaveLength(0);

    const missing = harness(new FakeCodexAppServer(), { findExecutable: () => null, which: () => false });
    await expect(missing.openSession({ cwd, sessionRef: null })).rejects.toThrow(NOT_INSTALLED);
    expect(await missing.listModels()).toEqual([]);
  });

  it("steers a running turn and holds follow-ups until it ends", async () => {
    const codex = new FakeCodexAppServer({ onTurn: () => {}, onSteer: () => {} });
    const { session, events, transcript } = await openSession(harness(codex));
    await session.prompt({ text: "first" });
    await until(() => codex.sent("turn/start").length === 1 && session.getState().isRunning);
    await until(() => !!codex.lastTurn());
    // wait for the turn id (turn/start answered)
    await until(() => events.some((e) => e.type === "state" && e.state.isRunning === true));
    await new Promise((r) => setTimeout(r, 20));
    await session.prompt({ text: "also this" });
    expect(codex.lastTurn().steered).toEqual(["also this"]);
    await session.prompt({ text: "later", behavior: "followUp" });
    expect(session.getState().queue.followUp).toEqual(["later"]);
    codex.lastTurn().reply("done");
    await until(() => codex.sent("turn/start").length === 2);
    expect(codex.lastTurn().text).toBe("later");
    codex.lastTurn().reply("done 2");
    await until(() => !session.getState().isRunning);
    expect(transcript().messages.filter((m) => m.role === "user").map(messageText)).toEqual(["first", "also this", "later"]);
  });

  it("stops a turn with turn/interrupt, and ends it anyway when Codex doesn't answer", async () => {
    const codex = new FakeCodexAppServer({ onTurn: (t) => void t.message("working…") });
    const { session, transcript } = await openSession(harness(codex));
    await session.prompt({ text: "go" });
    await until(() => assistants(transcript()).length === 1);
    await session.abort();
    await until(() => !session.getState().isRunning);
    expect(codex.sent("turn/interrupt")[0]).toMatchObject({ turnId: codex.lastTurn().id });
    expect(assistants(transcript())[0]!.stopReason).toBe("aborted");
    expect(codex.sent("thread/backgroundTerminals/list")).toHaveLength(0); // no commands were running

    const deaf = new FakeCodexAppServer({ onTurn: () => {}, interruptEnds: false });
    const second = await openSession(harness(deaf));
    await second.session.prompt({ text: "go" });
    await until(() => deaf.sent("turn/start").length === 1);
    await new Promise((r) => setTimeout(r, 10));
    await second.session.abort();
    await until(() => !second.session.getState().isRunning, 1000);
  });

  it("stops the commands a stopped turn was running, not earlier turns' background terminals (I-179)", async () => {
    const codex = new FakeCodexAppServer({
      onTurn: (t) => {
        t.started({ type: "commandExecution", id: "c-sleep", command: "/bin/zsh -lc 'sleep 40'", cwd, status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null });
        // Codex keeps an interrupted turn's commands as background terminals.
        codex.backgroundTerminals.set(t.thread.id, [
          { itemId: "c-server", processId: "11", command: "npm run dev" },
          { itemId: "c-sleep", processId: "22", command: "sleep 40" },
        ]);
      },
    });
    const { session, transcript } = await openSession(harness(codex));
    await session.prompt({ text: "sleep" });
    await until(() => assistants(transcript())[0]?.content.length === 1);
    await session.abort();
    await until(() => codex.terminatedTerminals.length === 1);
    expect(codex.sent("turn/interrupt")).toHaveLength(1);
    expect(codex.terminatedTerminals).toEqual(["22"]);
    expect(codex.backgroundTerminals.get(session.sessionRef!)!.map((t) => t.processId)).toEqual(["11"]);
    await until(() => !session.getState().isRunning);
    expect(transcript().toolResults["c-sleep"]).toMatchObject({ status: "error", output: "Stopped", stopped: true });
  });

  it("asks for approval with Codex's options: yes, don't ask again, and no (the turn stops)", async () => {
    const answers: unknown[] = [];
    const codex = new FakeCodexAppServer({
      onTurn: async (t) => {
        const item: ThreadItem = { type: "commandExecution", id: "c1", command: "npm test", cwd, status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
        t.started(item);
        answers.push(await t.ask("item/commandExecution/requestApproval", { itemId: "c1", command: "npm test", proposedExecpolicyAmendment: ["npm", "test"] }));
        t.completed({ ...item, status: "completed", aggregatedOutput: "ok", exitCode: 0 });
        const patch: ThreadItem = { type: "fileChange", id: "f1", status: "inProgress", changes: [{ path: "a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" }] };
        t.started(patch);
        const reply = await t.ask("item/fileChange/requestApproval", { itemId: "f1" });
        answers.push(reply);
        if ((reply as { decision: string }).decision === "cancel") t.complete("interrupted");
        else t.reply("ok");
      },
    });
    const { session, uiRequests, transcript } = await openSession(harness(codex));
    await session.prompt({ text: "test it" });
    await until(() => uiRequests().length === 1);
    const card = uiRequests()[0] as Extract<UiRequest, { kind: "permission" }>;
    expect(card).toMatchObject({ kind: "permission", title: "Would you like to run the following command?", message: "$ npm test", toolCallId: "c1", numbered: true });
    session.respondToUi({ id: card.id, value: "accept_always" });
    await until(() => uiRequests().length === 2);
    const files = uiRequests()[1] as Extract<UiRequest, { kind: "permission" }>;
    expect(files).toMatchObject({ title: "Would you like to make the following edits?", message: "a.ts", toolCallId: "f1" });
    expect(files.options.map((o) => o.label)).toEqual(["Yes, proceed", "Yes, and don't ask again for these files", "No, and tell Codex what to do differently"]);
    session.respondToUi({ id: files.id, value: "cancel" });
    await until(() => !session.getState().isRunning);
    expect(answers).toEqual([{ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } } }, { decision: "cancel" }]);
    expect(transcript().toolResults.f1).toMatchObject({ rejected: true });
    expect(assistants(transcript()).at(-1)!.stopReason).toBe("aborted");
  });

  it("asks Codex's questions as dialogs and declines MCP elicitations", async () => {
    const replies: unknown[] = [];
    const codex = new FakeCodexAppServer({
      onTurn: async (t) => {
        replies.push(await t.ask("item/tool/requestUserInput", { itemId: "q", questions: [{ id: "db", header: "Database", question: "Which one?", isOther: false, isSecret: false, options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }] }] }));
        replies.push(await t.ask("mcpServer/elicitation/request", { serverName: "x" }));
        t.reply("ok");
      },
    });
    const { session, uiRequests } = await openSession(harness(codex));
    await session.prompt({ text: "set up" });
    await until(() => uiRequests().length === 1);
    expect(uiRequests()[0]).toMatchObject({ kind: "select", title: "Database: Which one?", options: ["Postgres", "SQLite"] });
    session.respondToUi({ id: uiRequests()[0]!.id, value: "SQLite" });
    await until(() => !session.getState().isRunning);
    expect(replies).toEqual([{ answers: { db: { answers: ["SQLite"] } } }, { action: "decline", content: null, _meta: null }]);
  });

  it("gives threads Glade's tools as dynamic tools and runs them in Glade", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ agent: { name: "scout", displayName: "Leo" } }), { status: 200 });
    }) as typeof fetch;
    let reply: unknown;
    const codex = new FakeCodexAppServer({
      onTurn: async (t) => {
        reply = await t.ask("item/tool/call", { callId: "d1", namespace: null, tool: "spawn_agent", arguments: { name: "scout", task: "Look around" } });
        t.reply("spawned");
      },
    });
    const env = { GLADE_URL: "http://127.0.0.1:1", GLADE_TOKEN: "tok", GLADE_SESSION_ID: "s1" };
    const { run } = await openSession(harness(codex, { fetch: fetchImpl }), null, { env });
    // I-179: in a `glade` namespace (Codex's own spawn_agent can't shadow them), and the thread is told to use them.
    const start = codex.sent("thread/start")[0]!;
    const namespaces = start.dynamicTools as Array<{ type: string; name: string; tools: Array<{ name: string; inputSchema: { type: string } }> }>;
    expect(namespaces.map((n) => [n.type, n.name])).toEqual([["namespace", "glade"]]);
    const tools = namespaces[0]!.tools;
    expect(tools.map((t) => t.name)).toEqual(["spawn_agent", "message_agent", "list_agents", "close_agent", "find_chats", "read_chat", "open_chat"]);
    expect(start.developerInstructions).toMatch(/`glade` tool namespace.*Don't use your built-in `spawn_agent`/);
    expect(tools[0]!.inputSchema.type).toBe("object");
    await run("spawn one");
    expect(calls[0]).toEqual({ url: "http://127.0.0.1:1/api/agents/spawn", body: expect.objectContaining({ name: "scout", task: "Look around" }) });
    expect(reply).toMatchObject({ success: true, contentItems: [{ type: "inputText", text: expect.stringMatching(/Spawned Leo/) }] });
  });

  it("mirrors Codex's own sub-agents as native sub-agents: task and nickname from thread/read, its thread's items, its report (I-188)", async () => {
    const child = (t: FakeTurn, method: string, params: Record<string, unknown>) => t.notify(method, { threadId: "thr-child", turnId: "child-turn", ...params });
    const codex = new FakeCodexAppServer({
      subAgents: { "thr-child": { preview: "Count the files in src", agentNickname: "Euclid", agentRole: "explorer", model: "gpt-6-luna" } },
      onTurn: (t) => {
        t.item({ type: "subAgentActivity", id: "call_1", kind: "started", agentThreadId: "thr-child", agentPath: "/root/tiny" });
        // Its thread starts at once (before thread/read answered: these wait).
        t.notify("turn/started", { threadId: "thr-child", turn: { id: "child-turn", status: "inProgress", error: null } });
        const cmd = { type: "commandExecution" as const, id: "c1", command: "ls src | wc -l", cwd: "/p", status: "inProgress" as const, commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
        child(t, "item/started", { item: cmd });
        child(t, "item/completed", { item: { ...cmd, status: "completed", aggregatedOutput: "3\n", exitCode: 0, durationMs: 4 } });
        t.reply("spawned");
        setTimeout(() => {
          child(t, "item/started", { item: { type: "agentMessage", id: "cm", text: "" } });
          child(t, "item/agentMessage/delta", { itemId: "cm", delta: "3 files." });
          child(t, "item/completed", { item: { type: "agentMessage", id: "cm", text: "3 files." } });
          t.notify("turn/completed", { threadId: "thr-child", turn: { id: "child-turn", status: "completed", error: null } });
          t.notify("item/completed", { threadId: t.thread.id, turnId: t.id, item: { type: "subAgentActivity", id: "done-1", kind: "completed", agentThreadId: "thr-child", agentPath: "/root/tiny" } });
        }, 20);
      },
    });
    const { session, run, transcript } = await openSession(harness(codex));
    const natives: NativeSubagentEvent[] = [];
    session.onNativeSubagent((e) => natives.push(e));
    await run("spawn");
    expect(assistants(transcript())[0]!.content[0]).toMatchObject({ id: "call_1", kind: "task", input: { description: "Codex sub-agent /root/tiny" } });
    await until(() => natives.some((e) => e.type === "native_subagent_end"));
    expect(codex.sent("thread/read")).toEqual([{ threadId: "thr-child" }]);
    expect(natives[0]).toEqual({ type: "native_subagent_start", id: "thr-child", toolCallId: "call_1", name: "explorer", displayName: "Euclid", task: "Count the files in src", model: { provider: "codex", id: "gpt-6-luna" } });
    const child_ = fold(natives.flatMap((e) => (e.type === "native_subagent_event" ? [e.event] : [])));
    expect(assistants(child_).map((m) => m.content.map((b) => b.type))).toEqual([["toolCall"], ["text"]]);
    expect(child_.toolResults.c1).toMatchObject({ status: "done", output: "3\n" });
    expect(messageText(assistants(child_)[1]!)).toBe("3 files.");
    expect(natives.at(-1)).toEqual({ type: "native_subagent_end", id: "thr-child", status: "done", result: "3 files." });
    // The report goes into the parent's spawn call; no separate notice.
    expect(transcript().toolResults.call_1).toMatchObject({ status: "done", output: "3 files." });
    expect(transcript().messages.some((m) => m.role === "notice")).toBe(false);
  });

  it("Stop interrupts Codex's own sub-agents too, which ends them as stopped (I-188)", async () => {
    let parentTurn: FakeTurn | null = null;
    const codex = new FakeCodexAppServer({
      subAgents: { "thr-a": { preview: "A" }, "thr-b": { preview: "B" } },
      onTurn: (t) => {
        parentTurn = t;
        for (const id of ["thr-a", "thr-b"]) {
          t.item({ type: "subAgentActivity", id: `call-${id}`, kind: "started", agentThreadId: id, agentPath: `/root/${id}` });
          t.notify("turn/started", { threadId: id, turn: { id: `${id}-turn`, status: "inProgress", error: null } });
        }
        t.reply("spawned two"); // the parent's turn ends; the sub-agents work on
      },
      onChildInterrupt: (threadId, turnId) => setImmediate(() => parentTurn!.notify("turn/completed", { threadId, turn: { id: turnId, status: "interrupted", error: null } })),
    });
    const { session, run } = await openSession(harness(codex));
    const natives: NativeSubagentEvent[] = [];
    session.onNativeSubagent((e) => natives.push(e));
    await run("spawn two");
    await until(() => natives.filter((e) => e.type === "native_subagent_start").length === 2);
    await session.abort();
    await until(() => natives.filter((e) => e.type === "native_subagent_end").length === 2);
    expect(codex.sent("turn/interrupt")).toEqual(expect.arrayContaining([{ threadId: "thr-a", turnId: "thr-a-turn" }, { threadId: "thr-b", turnId: "thr-b-turn" }]));
    expect(natives.filter((e) => e.type === "native_subagent_end").map((e) => (e as { status: string }).status)).toEqual(["stopped", "stopped"]);
  });

  it("follows multi-agent v1's spawnAgent calls: the prompt is the task, its turn ends it (I-188)", async () => {
    const codex = new FakeCodexAppServer({
      subAgents: { "thr-v1": {} },
      onTurn: (t) => {
        const call = { type: "collabAgentToolCall" as const, id: "collab-1", tool: "spawnAgent", status: "completed", prompt: "Check the tests", receiverThreadIds: ["thr-v1"], agentsStates: {} };
        t.item(call);
        setTimeout(() => {
          t.notify("item/completed", { threadId: "thr-v1", turnId: "v1-turn", item: { type: "agentMessage", id: "vm", text: "All green." } });
          t.notify("turn/completed", { threadId: "thr-v1", turn: { id: "v1-turn", status: "completed", error: null } });
          t.reply("ok");
        }, 20);
      },
    });
    const { session, run } = await openSession(harness(codex));
    const natives: NativeSubagentEvent[] = [];
    session.onNativeSubagent((e) => natives.push(e));
    await run("check");
    await until(() => natives.some((e) => e.type === "native_subagent_end"));
    expect(natives[0]).toMatchObject({ type: "native_subagent_start", id: "thr-v1", toolCallId: "collab-1", task: "Check the tests" });
    expect(taskNameTitle("src_file_count")).toBe("Src file count");
    expect(natives.at(-1)).toEqual({ type: "native_subagent_end", id: "thr-v1", status: "done", result: "All green." });
  });

  it("sends model, thinking and permission mode changes with the next turn", async () => {
    const codex = new FakeCodexAppServer({ onTurn: (t) => t.reply("ok") });
    const { session, run } = await openSession(harness(codex));
    await session.setModel({ provider: "codex", id: "gpt-5.6-terra" });
    await session.setThinkingLevel("xhigh");
    await session.setPermissionMode("full-access");
    await expect(session.setPermissionMode("bypassPermissions")).rejects.toThrow(/can't switch/);
    await expect(session.setModel({ provider: "anthropic", id: "sonnet" })).rejects.toThrow(/can't use/);
    await run("go");
    expect(codex.sent("turn/start")[0]).toMatchObject({ model: "gpt-5.6-terra", effort: "xhigh", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
    expect(session.getState()).toMatchObject({ permissionMode: "full-access", thinkingLevel: "xhigh" });
  });

  it("starts a new chat in the preset of Codex's config and its configured model and effort", async () => {
    const codex = new FakeCodexAppServer({ config: { model: "gpt-5.6-terra", model_reasoning_effort: "xhigh", sandbox_mode: "read-only", approval_policy: "on-request" } });
    const h = harness(codex);
    const { session } = await openSession(h);
    expect(session.getState()).toMatchObject({ model: { id: "gpt-5.6-terra" }, thinkingLevel: "xhigh", permissionMode: "read-only" });
    expect(codex.sent("thread/start")[0]).toMatchObject({ sandbox: "read-only" });
    expect(await h.getDefaults()).toEqual({ model: { provider: "codex", id: "gpt-5.6-terra" }, thinkingLevel: "xhigh" });
    expect((await h.listModels()).map((m) => m.id)).toEqual(["gpt-5.6-terra", "gpt-6-luna"]);
    // A saved mode wins.
    const saved = await openSession(h, null, { permissionMode: "full-access" });
    expect(saved.session.getState().permissionMode).toBe("full-access");
    // The new-chat composer's pill (I-184): the presets, starting in the config's.
    const modes = await h.getPermissionModes();
    expect(modes.modes.map((m) => m.id)).toEqual(expect.arrayContaining(["read-only", "auto", "full-access"]));
    expect(modes.defaultMode).toBe("read-only");
  });

  it("compacts through thread/compact/start", async () => {
    const codex = new FakeCodexAppServer({ onTurn: (t) => t.reply("ok") });
    const { session, run, transcript } = await openSession(harness(codex));
    await run("hi");
    const result = await session.compact();
    expect(result).toEqual({ tokensBefore: 5000, tokensAfter: 1200 });
    expect(transcript().messages.at(-1)).toMatchObject({ role: "notice", kind: "compaction" });
    expect(session.getState().isRunning).toBe(false);
  });

  it("fails the running turn and exits the session when the app-server dies; the next chat starts a new one", async () => {
    const codex = new FakeCodexAppServer({ onTurn: (t) => void t.message("half") });
    const h = harness(codex);
    const { session, exits, transcript } = await openSession(h);
    await session.prompt({ text: "go" });
    await until(() => assistants(transcript()).length === 1);
    codex.live.crash();
    await until(() => exits.length === 1);
    expect(assistants(transcript()).at(-1)!.errorMessage).toMatch(/^Codex stopped: codex app-server exited/);
    const again = await openSession(h, session.sessionRef);
    expect(codex.connections).toHaveLength(2);
    expect(again.session.sessionRef).toBeTruthy();
  });
});

describe("Codex harness", () => {
  it("describes itself, reports usage limits and deletes the chat's thread", async () => {
    const codex = new FakeCodexAppServer({ rateLimits: LIMIT_REACHED });
    const h = harness(codex);
    expect(h.info).toEqual({ label: "Codex", capabilities: CODEX_CAPABILITIES });
    expect(await h.getUsageLimits()).toMatchObject({ provider: "codex", limits: [{ percent: 100, active: true }] });
    await h.deleteSession("thr-x");
    expect(codex.deleted).toEqual(["thr-x"]);
    expect(codex.sent("initialize")[0]).toMatchObject({ clientInfo: { name: "glade" }, capabilities: { experimentalApi: true } });
    expect(codex.connections).toHaveLength(1); // one shared process
  });

  it("traces every app-server message both ways with GLADE_CODEX_TRACE (I-179)", async () => {
    const file = join(dir, "trace.jsonl");
    const codex = new FakeCodexAppServer({ onTurn: (t) => t.reply("ok") });
    const { run } = await openSession(harness(codex, { traceFile: file }));
    await run("hi");
    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { dir: string; message: { method?: string } });
    expect(lines.find((l) => l.dir === "out" && l.message.method === "turn/start")).toBeTruthy();
    expect(lines.find((l) => l.dir === "in" && l.message.method === "turn/completed")).toBeTruthy();
  });

  it("frames JSON-RPC over a real child process's stdio (JSONL)", async () => {
    const script = join(dir, "fake-codex");
    writeFileSync(
      script,
      `#!${process.execPath}
if (process.argv[2] !== "app-server") process.exit(2);
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const m = JSON.parse(line);
    if (m.method === "echo") process.stdout.write(JSON.stringify({ method: "note", params: { text: "a\\u2028b" } }) + "\\n" + JSON.stringify({ id: m.id, result: m.params }) + "\\n");
    if (m.method === "quit") process.exit(3);
  }
});
`,
    );
    chmodSync(script, 0o755);
    const notes: unknown[] = [];
    const rpc = new CodexRpc(spawnCodexTransport({ executable: script, cwd: dir, env: process.env }), {
      notification: (method, params) => notes.push([method, params]),
      request: async () => ({}),
    });
    expect(await rpc.request("echo", { x: 1 })).toEqual({ x: 1 });
    expect(notes).toEqual([["note", { text: "a\u2028b" }]]);
    const closed = new Promise<Error | null>((resolve) => rpc.onClose(resolve));
    const pending = rpc.request("quit", {});
    await expect(pending).rejects.toThrow(/exited \(code 3\)/);
    expect(await closed).toBeInstanceOf(Error);
  });
});

describe("Codex slash commands and ! commands (I-178)", () => {
  it("maps skills and /review to slash commands and parses their arguments", () => {
    expect(codexSlashCommands(FAKE_SKILLS)).toEqual([
      { name: "review", source: "extension", description: "Ask Codex to review your changes (uncommitted by default)", argsHint: "[base <branch> | commit <sha> | instructions]" },
      { name: "issue-queue", source: "skill", description: "Collect issues into the Inbox." },
      { name: "pdf:pdf", source: "skill", description: "Read, create, render, and verify PDF files" },
    ]);
    expect(parseSlashText("/pdf:pdf  read a.pdf ")).toEqual({ name: "pdf:pdf", args: "read a.pdf" });
    expect(parseSlashText("hello /x")).toBeNull();
    expect(reviewTarget("")).toEqual({ type: "uncommittedChanges" });
    expect(reviewTarget("base main")).toEqual({ type: "baseBranch", branch: "main" });
    expect(reviewTarget("--base=origin/dev")).toEqual({ type: "baseBranch", branch: "origin/dev" });
    expect(reviewTarget("commit abc1234 Fix it")).toEqual({ type: "commit", sha: "abc1234", title: "Fix it" });
    expect(reviewTarget("look at the error handling")).toEqual({ type: "custom", instructions: "look at the error handling" });
    expect(skillInput(FAKE_SKILLS[1]!, "")).toEqual([
      { type: "text", text: "$pdf:pdf", text_elements: [] },
      { type: "skill", name: "pdf:pdf", path: FAKE_SKILLS[1]!.path },
    ]);
    expect(shellArgv("ls | wc", "/bin/bash")).toEqual(["/bin/bash", "-lc", "ls | wc"]);
    expect(shellArgv("ls", undefined)).toEqual(["/bin/zsh", "-lc", "ls"]);
    expect(userShellRecord("echo hi", 0, 12, "hi\n")).toBe("<user_shell_command>\n<command>\necho hi\n</command>\n<result>\nExit code: 0\nDuration: 0.0120 seconds\nOutput:\nhi\n\n</result>\n</user_shell_command>");
    expect(userShellRecord("x", 0, 0, "a".repeat(SHELL_RECORD_MAX_CHARS + 50)).length).toBeLessThan(SHELL_RECORD_MAX_CHARS + 300);
  });

  it("lists the folder's skills (cached until skills/changed) for chats and the new-chat composer", async () => {
    let skills = FAKE_SKILLS.slice(0, 1);
    const codex = new FakeCodexAppServer({ skills: () => skills });
    const h = harness(codex);
    expect((await h.listFolderCommands(cwd)).map((c) => c.name)).toEqual(["review", "issue-queue"]);
    expect(codex.sent("skills/list")[0]).toEqual({ cwds: [cwd] });
    const { session } = await openSession(h);
    skills = FAKE_SKILLS;
    expect((await session.listCommands()).map((c) => c.name)).toEqual(["review", "issue-queue"]); // cached
    expect(codex.sent("skills/list")).toHaveLength(1);
    codex.live.deliver({ method: "skills/changed", params: {} });
    await new Promise((r) => setTimeout(r, 5));
    expect((await session.listCommands()).map((c) => c.name)).toEqual(["review", "issue-queue", "pdf:pdf"]);
    expect(codex.sent("skills/list")).toHaveLength(2);
    expect(h.info.capabilities).toMatchObject({ commands: true, shell: true });
  });

  it("sends /<skill> as a skill item with the rest as text; other slash text goes as is", async () => {
    const codex = new FakeCodexAppServer({ onTurn: (t) => t.reply("ok") });
    const { run, transcript } = await openSession(harness(codex));
    await run("/pdf:pdf summarize report.pdf");
    expect(codex.sent("turn/start")[0]!.input).toEqual([
      { type: "text", text: "$pdf:pdf summarize report.pdf", text_elements: [] },
      { type: "skill", name: "pdf:pdf", path: FAKE_SKILLS[1]!.path },
    ]);
    await run("/nope hi");
    expect(codex.sent("turn/start")[1]!.input).toEqual([{ type: "text", text: "/nope hi", text_elements: [] }]);
    expect(transcript().messages.filter((m) => m.role === "user").map(messageText)).toEqual(["/pdf:pdf summarize report.pdf", "/nope hi"]);
  });

  it("runs /review with review/start and shows the review as the reply (once)", async () => {
    const codex = new FakeCodexAppServer({ onTurn: () => {}, onReview: (t) => t.review("- [P1] Null check missing in a.ts:3") });
    const { session, run, transcript, events } = await openSession(harness(codex));
    await run("/review base main");
    expect(codex.sent("review/start")[0]).toEqual({ threadId: session.sessionRef, target: { type: "baseBranch", branch: "main" }, delivery: "inline" });
    expect(codex.sent("turn/start")).toHaveLength(0);
    const t = transcript();
    expect(t.messages.map((m) => [m.role, messageText(m)])).toEqual([
      ["user", "/review base main"],
      ["notice", "Reviewing: current changes"],
      ["assistant", "- [P1] Null check missing in a.ts:3"],
    ]);
    expect(assistants(t)[0]!.stopReason).toBe("stop");

    // A review sent while a turn runs waits for it (never steered).
    await session.prompt({ text: "work" });
    await until(() => codex.sent("turn/start").length === 1 && !!codex.lastTurn());
    await new Promise((r) => setTimeout(r, 20));
    await session.prompt({ text: "/review" });
    expect(codex.lastTurn().steered).toEqual([]);
    expect(session.getState().queue.followUp).toEqual(["/review"]);
    const ends = events.filter((e) => e.type === "run_end").length;
    codex.lastTurn().reply("done");
    await until(() => codex.sent("review/start").length === 2);
    expect(codex.sent("review/start")[1]!.target).toEqual({ type: "uncommittedChanges" });
    await until(() => events.filter((e) => e.type === "run_end").length >= ends + 2);
  });

  it("runs !cmd with command/exec in the folder and sandbox, streams it, and shares it with Codex", async () => {
    const codex = new FakeCodexAppServer({ onTurn: (t) => t.reply("ok") });
    const h = harness(codex, { env: { PATH: "/usr/bin", HOME: "/Users/me", SHELL: "/bin/bash" } });
    const { session, events, run, transcript } = await openSession(h, null, { permissionMode: "read-only" });
    const result = await session.runShell({ id: "s1", command: "echo hi", shareWithAgent: true });
    expect(result).toEqual({ output: "fake output of: echo hi\n", exitCode: 0, cancelled: false, truncated: false });
    expect(codex.sent("command/exec")[0]).toMatchObject({
      command: ["/bin/bash", "-lc", "echo hi"],
      cwd,
      streamStdoutStderr: true,
      disableTimeout: true,
      sandboxPolicy: { type: "dangerFullAccess" }, // unsandboxed like Codex's own `!`, even in Read only
    });
    expect(events.filter((e) => e.type.startsWith("shell_")).map((e) => e.type)).toEqual(["shell_start", "shell_update", "shell_update", "shell_end"]);
    const shell = transcript().messages.find((m) => m.role === "shell")!;
    expect(shell).toMatchObject({ command: "echo hi", shared: true, running: false, exitCode: 0, output: "fake output of: echo hi\n" });
    // Idle: added to Codex's history right away, in Codex's own record.
    const thread = codex.threads.get(session.sessionRef!)!;
    expect(thread.injected).toHaveLength(1);
    expect(JSON.stringify(thread.injected[0])).toContain("<user_shell_command>\\n<command>\\necho hi");
    expect(thread.injected[0]).toMatchObject({ type: "message", role: "user", content: [{ type: "input_text" }] });

    // !! is never shared.
    await session.runShell({ id: "s2", command: "secret", shareWithAgent: false });
    expect(thread.injected).toHaveLength(1);
    await run("next");
    expect(codex.sent("turn/start")[0]!.input).toEqual([{ type: "text", text: "next", text_elements: [] }]);
  });

  it("shares a !cmd run during a turn with the next message, reports failures and stops commands", async () => {
    let release = () => {};
    const codex = new FakeCodexAppServer({
      onTurn: (t) => {
        if (t.text.includes("first")) release = () => t.reply("done");
        else t.reply("ok");
      },
      onExec: async (e) => {
        const command = (e.params.command as string[]).at(-1)!;
        if (command === "sleep 9") {
          e.output("waiting\n", "stderr");
          await e.terminated;
          return { exitCode: 137, stdout: "", stderr: "" };
        }
        if (command === "big") {
          e.output("é".repeat(2).slice(0, 1), "stdout", true);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        e.output("boom\n", "stderr");
        return { exitCode: 2, stdout: "", stderr: "" };
      },
    });
    const { session, run } = await openSession(harness(codex));
    await session.prompt({ text: "first" });
    await until(() => codex.sent("turn/start").length === 1 && session.getState().isRunning);
    const failed = await session.runShell({ id: "s1", command: "false", shareWithAgent: true });
    expect(failed).toMatchObject({ output: "boom\n", exitCode: 2, cancelled: false });
    expect(codex.sent("thread/inject_items")).toHaveLength(0); // a turn runs: waits for the next message
    release();
    await until(() => !session.getState().isRunning);
    await run("second");
    const input = codex.sent("turn/start")[1]!.input as Array<{ type: string; text: string }>;
    expect(input).toHaveLength(2);
    expect(input[0]!.text).toContain("<command>\nfalse\n</command>\n<result>\nExit code: 2");
    expect(input[1]!.text).toBe("second");

    const running = session.runShell({ id: "s2", command: "sleep 9", shareWithAgent: false });
    await until(() => codex.sent("command/exec").length === 2);
    await new Promise((r) => setTimeout(r, 10));
    await session.abortShell();
    expect(await running).toEqual({ output: "waiting\n", exitCode: null, cancelled: true, truncated: false });
    expect(codex.sent("command/exec/terminate")[0]).toEqual({ processId: expect.stringContaining("s2") });

    expect(await session.runShell({ id: "s3", command: "big", shareWithAgent: false })).toMatchObject({ output: "é", truncated: true });
  });

  it("runs ! commands in a Codex chat through the app service", async () => {
    const codex = new FakeCodexAppServer({ onTurn: (t) => t.reply("ok") });
    const store = new Store(join(dir, "data"), 0);
    const service = new AppService({ store, harnesses: new HarnessRegistry([harness(codex)]), scratchDir: cwd });
    try {
      const created = await service.createWorkspace({ projectId: null, harness: "codex" });
      const id = created.session.session.id;
      await service.runShell(id, { command: "echo hi", shareWithAgent: false });
      await until(() => store.loadTranscript(id).messages.some((m) => m.role === "shell" && !m.running));
      expect(store.loadTranscript(id).messages[0]).toMatchObject({ role: "shell", command: "echo hi", output: "fake output of: echo hi\n", shared: false });
      expect((await service.listCommands(id)).map((c) => c.name)).toContain("pdf:pdf");
    } finally {
      await service.dispose();
    }
  });
});

describe("Codex chats through the app service", () => {
  it("creates a Codex chat, keeps the thread id and model, and each chat's own permission mode", async () => {
    const options: FakeCodexOptions = { onTurn: (t) => t.reply("It's a readme.") };
    const codex = new FakeCodexAppServer(options);
    const store = new Store(join(dir, "data"), 0);
    const registry = new HarnessRegistry([new FakeHarness(undefined, 0, { id: "pi" }), harness(codex)]);
    const service = new AppService({ store, harnesses: registry, scratchDir: cwd });
    try {
      expect(service.listHarnesses().map((h) => h.id)).toEqual(["pi", "codex"]);
      const models = await service.listModels();
      expect(models.filter((m) => m.harness === "codex").map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-5.6-terra"]);

      const created = await service.createWorkspace({ projectId: null, harness: "codex", prompt: "what is this?" });
      const id = created.session.session.id;
      await until(() => !service.listSessions(created.workspace.id)[0]!.running && store.loadTranscript(id).messages.length >= 2, 2000);
      expect(store.loadTranscript(id).messages.map((m) => [m.role, messageText(m)])).toEqual([
        ["user", "what is this?"],
        ["assistant", "It's a readme."],
      ]);
      expect(store.getSession(id)!.sessionRef).toBe(codex.sent("turn/start")[0]!.threadId);
      expect(store.getSession(id)!.model).toEqual({ provider: "codex", id: "gpt-6-luna" });

      await service.setPermissionMode(id, "read-only");
      await until(() => store.getSession(id)!.permissionMode === "read-only");
      const second = await service.createWorkspace({ projectId: null, harness: "codex" });
      expect((await service.getSessionDetail(second.session.session.id)).state.permissionMode).toBe("auto");
    } finally {
      await service.dispose();
    }
  });
});

describe("Codex Plan mode (I-186)", () => {
  const PLAN = "# Add --version\n\n## Summary\nPrint the version.\n\n## Steps\n- Read package.json\n- Add the flag";
  const planTurn = (t: FakeTurn) => {
    if (t.collaborationMode === "plan") {
      t.message("I looked around.");
      t.proposePlan(PLAN, ["# Add --version\n\n## Sum", "mary\nPrint the version.\n", "\n## Steps\n- Read package.json\n- Add the flag"]);
      t.complete();
    } else t.reply("Done.");
  };
  type PermissionCard = Extract<UiRequest, { kind: "permission" }>;

  it("streams a proposed plan as a plan notice without steps, below the reply so far", () => {
    const t = new CodexTranslator("p");
    const events = [
      ...t.itemStarted({ type: "agentMessage", id: "m1", text: "" }),
      ...t.agentDelta("m1", "Exploring."),
      ...t.itemStarted({ type: "plan", id: "p1", text: "" }),
      ...t.planDelta("p1", "# Title\nfirst"),
    ];
    const streaming = fold(events).messages.find((m): m is NoticeMessage => m.role === "notice")!;
    expect(streaming).toMatchObject({ kind: "plan", text: "# Title" });
    expect(streaming.plan).toBeUndefined();
    expect(t.planDelta("p1", " half")).toEqual([]); // no new line yet: no update
    events.push(...t.itemCompleted({ type: "plan", id: "p1", text: "# Title\nfirst half\n" }), ...t.finish({ stopReason: "stop" }));
    const transcript = fold(events);
    expect(transcript.messages.map((m) => [m.role, messageText(m)])).toEqual([
      ["assistant", "Exploring."],
      ["notice", "# Title\nfirst half"],
    ]);
    expect(assistants(transcript)[0]!.streaming).toBe(false);
  });

  it("plans in Codex's Plan mode, asks \"Implement this plan?\" after the turn, and implements in the mode it came from", async () => {
    const codex = new FakeCodexAppServer({ onTurn: planTurn });
    const { session, run, transcript, uiRequests, events } = await openSession(harness(codex));
    expect(codex.sent("collaborationMode/list")).toHaveLength(1);
    expect(session.getState().permissionModes!.map((m) => m.id)).toEqual(["read-only", "auto", "plan", "full-access"]);
    await session.setThinkingLevel("low");
    await session.setPermissionMode("plan");
    await run("plan how to add a --version flag");

    const [first] = codex.sent("turn/start");
    // The preset it came from (Auto) keeps its approvals and sandbox; the chat's model and effort go in the mode.
    expect(first).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "workspaceWrite" },
      collaborationMode: { mode: "plan", settings: { model: "gpt-6-luna", reasoning_effort: "low", developer_instructions: null } },
    });
    const plans = transcript().messages.filter((m): m is NoticeMessage => m.role === "notice" && m.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ text: PLAN });
    expect(plans[0]!.plan).toBeUndefined();

    // After run_end: Codex's prompt, worded like its TUI.
    await until(() => uiRequests().length === 1);
    const runEnd = events.findIndex((e) => e.type === "run_end");
    expect(events.findIndex((e) => e.type === "ui_request")).toBeGreaterThan(runEnd);
    const card = uiRequests()[0] as PermissionCard;
    expect(card).toMatchObject({ kind: "permission", title: "Implement this plan?", numbered: true });
    expect(card.options.map((o) => [o.label, o.kind])).toEqual([
      ["Yes, implement this plan", "allow_once"],
      ["No, stay in Plan mode", "reject_once"],
    ]);
    session.respondToUi({ id: card.id, value: "implement" });
    await until(() => codex.sent("turn/start").length === 2 && !session.getState().isRunning);
    expect(session.getState().permissionMode).toBe("auto");
    const second = codex.sent("turn/start")[1]!;
    expect(second).toMatchObject({ input: [{ type: "text", text: "Implement the plan." }], collaborationMode: { mode: "default" } });
    expect(transcript().messages.filter((m) => m.role === "user").map(messageText)).toEqual(["plan how to add a --version flag", "Implement the plan."]);
    // Out of Plan mode for good: later turns send no collaboration mode.
    await run("thanks");
    expect(codex.sent("turn/start")[2]!.collaborationMode).toBeUndefined();
  });

  it("stays in Plan mode on no, and a new message instead closes the prompt", async () => {
    const codex = new FakeCodexAppServer({ onTurn: planTurn });
    const { session, run, uiRequests, events } = await openSession(harness(codex), null, { permissionMode: "plan" });
    await session.setPermissionMode("read-only");
    await session.setPermissionMode("plan");
    await run("plan it");
    await until(() => uiRequests().length === 1);
    const card = uiRequests()[0] as PermissionCard;
    expect(card.message).toBeUndefined();
    expect(card.options[1]).toMatchObject({ focusComposer: true });
    session.respondToUi({ id: card.id, value: "stay" });
    await new Promise((r) => setTimeout(r, 20));
    expect(codex.sent("turn/start")).toHaveLength(1);
    expect(session.getState().permissionMode).toBe("plan");

    await run("also cover the tests");
    await until(() => uiRequests().length === 2);
    await session.prompt({ text: "one more thing" });
    await until(() => events.some((e) => e.type === "ui_request_closed" && e.id === uiRequests()[1]!.id));
    await until(() => codex.sent("turn/start").length === 3);
    expect(codex.sent("turn/start").map((p) => (p.collaborationMode as { mode: string }).mode)).toEqual(["plan", "plan", "plan"]);
    expect(codex.sent("turn/start")[2]).toMatchObject({ sandboxPolicy: { type: "readOnly" } });
  });

  it("switches a resumed thread Codex still has in Plan mode back to Default; no Plan mode without collaboration modes", async () => {
    const codex = new FakeCodexAppServer({ onTurn: (t) => t.reply("ok") });
    codex.addThread("thr-planned").collaborationMode = { mode: "plan", settings: { model: "gpt-6-luna", reasoning_effort: "low", developer_instructions: null } };
    const { run } = await openSession(harness(codex), "thr-planned", { permissionMode: "auto" });
    await run("go");
    expect(codex.sent("turn/start")[0]!.collaborationMode).toMatchObject({ mode: "default" });

    const old = new FakeCodexAppServer({ collaborationModes: null, onTurn: (t) => t.reply("ok") });
    const { session } = await openSession(harness(old), null, { permissionMode: "plan" });
    expect(session.getState().permissionModes!.map((m) => m.id)).toEqual(["read-only", "auto", "full-access"]);
    expect(session.getState().permissionMode).toBe("auto");
    await expect(session.setPermissionMode("plan")).rejects.toThrow(/can't switch/);
  });

  it("keeps the plan card and the pending prompt through the app service; yes implements", async () => {
    const codex = new FakeCodexAppServer({ onTurn: planTurn });
    const store = new Store(join(dir, "data"), 0);
    const service = new AppService({ store, harnesses: new HarnessRegistry([harness(codex)]), scratchDir: cwd });
    try {
      const created = await service.createWorkspace({ projectId: null, harness: "codex" });
      const id = created.session.session.id;
      await service.setPermissionMode(id, "plan");
      await until(() => store.getSession(id)!.permissionMode === "plan");
      await service.prompt(id, { text: "plan it" });
      let detail = await service.getSessionDetail(id);
      for (let i = 0; i < 100 && detail.pendingUiRequests.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
        detail = await service.getSessionDetail(id);
      }
      expect(detail.pendingUiRequests[0]).toMatchObject({ title: "Implement this plan?" });
      expect(detail.session.running).toBe(false);
      expect(store.loadTranscript(id).messages.find((m) => m.role === "notice")).toMatchObject({ kind: "plan", text: PLAN });
      service.respondToUi(id, { id: detail.pendingUiRequests[0]!.id, value: "implement" });
      await until(() => store.loadTranscript(id).messages.some((m) => m.role === "assistant" && messageText(m) === "Done."), 2000);
      await until(() => store.getSession(id)!.permissionMode === "auto");
    } finally {
      await service.dispose();
    }
  });

  it("tells open chats their commands changed when Codex reports skills/changed (I-185)", async () => {
    const codex = new FakeCodexAppServer();
    const h = harness(codex);
    const a = await openSession(h);
    const b = await openSession(h);
    codex.live.deliver({ method: "skills/changed", params: {} });
    await until(() => a.events.some((e) => e.type === "commands_changed") && b.events.some((e) => e.type === "commands_changed"));
  });
});
