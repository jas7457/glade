/**
 * I-177: Codex as a native harness over the `codex app-server` protocol, against a scripted fake
 * app-server (`fixtures/fake-codex-app-server.ts`; never the real CLI or a model). Covers the
 * translator (streaming, tools, diffs, plan), models, errors and limits (the real usage-limit
 * payloads), permissions, sessions (threads, turns, steer/follow-up, stop, approvals, questions,
 * Glade's tools, compaction, crashes), the harness and a chat through the app service, plus the
 * JSONL framing against a real child process.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAgentEvent, messageText, type AgentEvent, type AssistantMessage, type NoticeMessage, type Transcript, type UiRequest } from "@glade/protocol";
import { CODEX_CAPABILITIES, CodexHarness } from "../src/harness/codex/codex-harness.js";
import type { CodexSession } from "../src/harness/codex/codex-session.js";
import { NOT_INSTALLED, NOT_LOGGED_IN, codexUsageLimits, formatReset, friendlyTurnError, usageLimitMessage } from "../src/harness/codex/errors.js";
import { codexThinkingLevels, effortToLevel, translateCodexModels } from "../src/harness/codex/models.js";
import { codexPermissionModes, commandApproval, commandDecision, modeFromConfig, turnPermissions } from "../src/harness/codex/permissions.js";
import type { ThreadItem } from "../src/harness/codex/protocol.js";
import { CodexRpc, spawnCodexTransport } from "../src/harness/codex/rpc.js";
import { codexDiff } from "../src/harness/codex/tools.js";
import { CodexTranslator } from "../src/harness/codex/translate.js";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { AppService } from "../src/services/app-service.js";
import { Store } from "../src/store/store.js";
import { FAKE_MODELS, FakeCodexAppServer, LIMIT_REACHED, USAGE_LIMIT_ERROR, type FakeCodexOptions } from "./fixtures/fake-codex-app-server.js";
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
    ];
    const transcript = fold(events);
    expect(assistants(transcript)[0]!.content).toMatchObject([
      { name: "mcp__docs__search", kind: "mcp", input: { server: "docs", tool: "search" } },
      { name: "web_search", kind: "web", input: { query: "codex app-server" } },
      { name: "spawn_agent", kind: "task", input: { agentName: "scout" } },
      { kind: "task", input: { description: "Check the tests" } },
    ]);
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
    expect(transcript.toolResults.c).toMatchObject({ status: "error", output: "Stopped" });
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
    expect(codex.sent("thread/resume")[0]).toMatchObject({ threadId: "thr-saved", excludeTurns: true, cwd });
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

    const deaf = new FakeCodexAppServer({ onTurn: () => {}, interruptEnds: false });
    const second = await openSession(harness(deaf));
    await second.session.prompt({ text: "go" });
    await until(() => deaf.sent("turn/start").length === 1);
    await new Promise((r) => setTimeout(r, 10));
    await second.session.abort();
    await until(() => !second.session.getState().isRunning, 1000);
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
    const tools = codex.sent("thread/start")[0]!.dynamicTools as Array<{ name: string; inputSchema: { type: string } }>;
    expect(tools.map((t) => t.name)).toEqual(["spawn_agent", "message_agent", "list_agents", "close_agent", "find_chats", "read_chat", "open_chat"]);
    expect(tools[0]!.inputSchema.type).toBe("object");
    await run("spawn one");
    expect(calls[0]).toEqual({ url: "http://127.0.0.1:1/api/agents/spawn", body: expect.objectContaining({ name: "scout", task: "Look around" }) });
    expect(reply).toMatchObject({ success: true, contentItems: [{ type: "inputText", text: expect.stringMatching(/Spawned Leo/) }] });
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
