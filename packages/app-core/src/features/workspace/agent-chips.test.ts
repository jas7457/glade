/** I-080/I-084: sub-agent chips (status, time, model, activity, identity, truncation). */
import { describe, expect, it } from "vitest";
import type { ContentBlock, ModelInfo, SessionAgentState, ToolResult, Transcript } from "@glade/protocol";
import { makeSession } from "@glade/app-core/test/fixtures";
import { agentChip, CHIP_TEXT_MAX, chipKind, chipTooltip, latestActivity, shortModelName, taskSummary, toolInWords, truncateText } from "./agent-chips";

const agent = (over: Partial<SessionAgentState> = {}): SessionAgentState => ({
  status: "working",
  agent: null,
  task: "Review the login flow\nDetails follow…",
  keepOpenReason: null,
  userEngaged: false,
  closing: false,
  doneAt: null,
  result: null,
  ...over,
});
const sub = (over: Parameters<typeof makeSession>[0]) =>
  makeSession({ kind: "subagent", parentSessionId: "m", agentName: "reviewer", agent: agent(), createdAt: 1_000, ...over });

const models: ModelInfo[] = [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", thinkingLevels: ["off"] } as ModelInfo];

const result = (status: ToolResult["status"]): ToolResult => ({ toolCallId: "t1", toolName: "bash", status, output: "" });
function transcript(blocks: ContentBlock[], results: Record<string, ToolResult> = {}, streaming = false): Transcript {
  return { messages: [{ id: "a", role: "assistant", content: blocks, timestamp: 1, streaming }], toolResults: results };
}
const bash = { type: "toolCall" as const, id: "t1", name: "bash", kind: "shell" as const, input: { command: "pnpm test" }, args: { command: "pnpm test" } };

describe("chipKind", () => {
  it("maps session + agent state to a chip status, attention first", () => {
    expect(chipKind(sub({ id: "a", status: "working" }))).toBe("working");
    expect(chipKind(sub({ id: "a", status: "blocked" }))).toBe("blocked");
    expect(chipKind(sub({ id: "a", status: "idle", agent: agent({ status: "done" }) }))).toBe("done");
    expect(chipKind(sub({ id: "a", status: "idle", agent: agent({ status: "closed" }) }))).toBe("failed");
    expect(chipKind(sub({ id: "a", status: "idle", lastRunFailed: true, agent: agent({ status: "idle" }) }))).toBe("failed");
    expect(chipKind(sub({ id: "a", status: "working", agent: agent({ closing: true }) }))).toBe("closing");
    expect(chipKind(sub({ id: "a", status: "idle", agent: agent({ status: "idle" }) }))).toBe("idle");
  });
});

describe("shortModelName", () => {
  it("drops the Claude prefix, falls back to the id", () => {
    expect(shortModelName({ provider: "anthropic", id: "claude-sonnet-4-5" }, models)).toBe("Sonnet 4.5");
    expect(shortModelName({ provider: "x", id: "claude-haiku-4-5" }, [])).toBe("haiku-4-5");
    expect(shortModelName(null, models)).toBeNull();
  });
});

describe("latestActivity", () => {
  it("shows tool paths relative to the chat's folder when it's known (I-158)", () => {
    const edit = { type: "toolCall" as const, id: "t1", name: "edit", kind: "edit" as const, input: { path: "/Users/me/app/src/a.ts" }, args: {} };
    expect(latestActivity(transcript([edit], { t1: result("done") }), "/Users/me/app")).toBe("Edited src/a.ts");
    expect(latestActivity(transcript([edit], { t1: result("done") }))).toBe("Edited /Users/me/app/src/a.ts");
  });

  it("shows the running tool call, else the latest reply line or finished call", () => {
    expect(latestActivity(null)).toBe("");
    expect(latestActivity(transcript([{ type: "text", text: "Checking." }, bash], { t1: result("running") }))).toBe("Running pnpm test");
    expect(latestActivity(transcript([bash], { t1: result("done") }))).toBe("Ran pnpm test");
    expect(latestActivity(transcript([bash, { type: "text", text: "All green.\n\n**Tests pass.**" }], { t1: result("done") }))).toBe("Tests pass.");
    // A call still streaming its args (no result yet) counts as running.
    expect(latestActivity(transcript([bash], {}, true))).toBe("Running pnpm test");
  });

  it("between steps shows Thinking… instead of nothing (I-130)", () => {
    const toolTurn = { id: "a1", role: "assistant" as const, content: [bash], timestamp: 1 };
    const next = (content: ContentBlock[], streaming: boolean) => ({ id: "a2", role: "assistant" as const, content, timestamp: 2, streaming });
    const results = { t1: result("done") };
    // pi starts a new, empty assistant message after the tool result.
    expect(latestActivity({ messages: [toolTurn, next([], true)], toolResults: results })).toBe("Thinking…");
    // …which first holds only a thinking block.
    expect(latestActivity({ messages: [toolTurn, next([{ type: "thinking", text: "Hmm" }], true)], toolResults: results })).toBe("Thinking…");
    // A finished message without text or calls falls back to the previous step.
    expect(latestActivity({ messages: [toolTurn, next([{ type: "thinking", text: "Hmm" }], false)], toolResults: results })).toBe("Ran pnpm test");
    // First start: nothing yet (callers show "Starting…"); thinking already reads "Thinking…".
    expect(latestActivity({ messages: [{ id: "u", role: "user", content: [{ type: "text", text: "Go" }], timestamp: 0 }], toolResults: {} })).toBe("");
    expect(latestActivity(transcript([], {}, true))).toBe("Thinking…");
  });
});

describe("agentChip", () => {
  it("says a native sub-agent that ended early was stopped, with why (I-188)", () => {
    const chip = agentChip(sub({ id: "a", status: "idle", agent: agent({ status: "closed", native: "Codex", result: "Stopped with its parent" }) }), null, [], 2_000);
    expect(chip).toMatchObject({ kind: "failed", label: "Stopped", activity: "Stopped with its parent" });
    expect(agentChip(sub({ id: "a", status: "idle", agent: agent({ status: "closed" }) }), null, [], 2_000)).toMatchObject({ label: "Exited", activity: "Process stopped" });
  });

  it("derives label, attention, elapsed, model, activity and task", () => {
    const working = agentChip(sub({ id: "a", status: "working", model: { provider: "anthropic", id: "claude-sonnet-4-5" } }), null, models, 66_000);
    expect(working).toMatchObject({ name: "reviewer", kind: "working", label: "Working", running: true, attention: null, elapsedMs: 65_000, model: "Sonnet 4.5", activity: "Starting…", task: "Review the login flow" });

    const blocked = agentChip(sub({ id: "a", status: "blocked" }), null, [], 2_000);
    expect(blocked).toMatchObject({ kind: "blocked", label: "Needs input", attention: "warning", running: true, activity: "Waiting for your input" });

    const done = agentChip(sub({ id: "a", status: "idle", agent: agent({ status: "done", doneAt: 31_000, result: "## Summary\nLooks **good**." }) }), null, [], 99_000);
    expect(done).toMatchObject({ kind: "done", label: "Done", running: false, elapsedMs: 30_000, activity: "Looks good.", result: "## Summary\nLooks **good**." });

    const exited = agentChip(sub({ id: "a", status: "idle", lastActivityAt: 5_000, agent: agent({ status: "closed" }) }), null, [], 99_000);
    expect(exited).toMatchObject({ kind: "failed", label: "Exited", attention: "danger", elapsedMs: 4_000 });
  });
});

describe("chip identity and text", () => {
  it("uses the fun name and colour, falling back to the agent name and a colour from its id", () => {
    const named = agentChip(sub({ id: "a", status: "working", agentDisplayName: "Maya", agentColor: "teal" }), null, [], 2_000);
    expect(named.identity).toEqual({ displayName: "Maya", role: "reviewer", color: "teal", icon: null, harness: null });
    const old = agentChip(sub({ id: "a", status: "working" }), null, [], 2_000);
    expect(old.identity.displayName).toBe("reviewer");
    expect(old.identity.role).toBeNull();
    expect(agentChip(sub({ id: "a", status: "working" }), null, [], 2_000).identity.color).toBe(old.identity.color);
  });

  it("truncates the activity for the chip, keeping the full text", () => {
    const long = "Running pnpm test --filter ./apps/web --reporter verbose";
    const t = transcript([{ ...bash, input: { command: "pnpm test --filter ./apps/web --reporter verbose" } }], { t1: result("running") });
    const chip = agentChip(sub({ id: "a", status: "working" }), t, [], 2_000);
    expect(chip.activity).toBe(long);
    expect(chip.shortActivity.length).toBeLessThanOrEqual(CHIP_TEXT_MAX);
    expect(chip.shortActivity.endsWith("…")).toBe(true);
  });
});

describe("activity in words (I-148)", () => {
  const call = (name: string) => ({ type: "toolCall" as const, id: "t1", name, kind: "other" as const, args: { summary: "All done" } });
  it("names agent tools in words and humanizes unknown ones, without raw args", () => {
    expect(latestActivity(transcript([call("report_done")], { t1: result("running") }))).toBe("Reporting back");
    expect(latestActivity(transcript([call("mcp__pi__report_done")], { t1: result("done") }))).toBe("Reported back");
    expect(toolInWords("spawn_agent", true)).toBe("Starting an agent");
    expect(toolInWords("bash", true)).toBe("Running a command");
    expect(toolInWords("run_checks", true)).toBe("Run checks");
    expect(toolInWords("mcp__server__fetchIssueList", false)).toBe("Fetch issue list");
  });

  it("keeps known kinds' wording: commands, files", () => {
    const read = { type: "toolCall" as const, id: "t1", name: "read", kind: "read" as const, input: { path: "src/app.ts" }, args: {} };
    const edit = { ...read, name: "edit", kind: "edit" as const };
    expect(latestActivity(transcript([read], { t1: result("running") }))).toBe("Reading src/app.ts");
    expect(latestActivity(transcript([edit], { t1: result("running") }))).toBe("Editing src/app.ts");
    expect(latestActivity(transcript([{ ...bash, input: {} }], { t1: result("running") }))).toBe("Running a command");
  });
});

describe("chip title and tooltip (I-148)", () => {
  const long = "Review the login flow for session fixation, CSRF and every other thing that could go wrong in there, thoroughly. Then report.";

  it("leads with the generated title", () => {
    const t = transcript([{ type: "toolCall", id: "t1", name: "report_done", kind: "other", args: {} }], { t1: result("running") });
    const chip = agentChip(sub({ id: "a", status: "working", title: "Login flow security review", titleSource: "auto", agentDisplayName: "Maya", model: { provider: "anthropic", id: "claude-sonnet-4-5" } }), t, models, 66_000);
    expect(chip.title).toBe("Login flow security review");
    expect(chipTooltip(chip, false)).toBe("Maya · Login flow security review — Working · 1m 5s · Sonnet 4.5\nNow: Reporting back\nClick to open");
    expect(chipTooltip(chip, true).split("\n").at(-1)).toBe("Click to hide");
    expect(chipTooltip(chip, false)).not.toContain("Task:");
  });

  it("falls back to the functional name and the task's first sentence (cut at ~100 chars)", () => {
    const pending = agentChip(sub({ id: "a", status: "working", title: "reviewer", agentDisplayName: "Maya" }), null, [], 2_000);
    expect(pending.title).toBeNull();
    expect(pending.summary).toBe("reviewer: Review the login flow");
    expect(chipTooltip(pending, false).split("\n")[0]).toMatch(/^Maya · reviewer: Review the login flow — Working · /);
    const cut = taskSummary("reviewer", long);
    expect(cut.startsWith("reviewer: Review the login flow for session fixation")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual("reviewer: ".length + 100);
    expect(cut.endsWith("…")).toBe(true);
    expect(taskSummary("reviewer", "Fix it. Then test.")).toBe("reviewer: Fix it.");
    expect(taskSummary("reviewer", "")).toBe("reviewer");
  });

  it("says Latest instead of Now once it's done", () => {
    const done = agentChip(sub({ id: "a", status: "idle", agent: agent({ status: "done", doneAt: 31_000, result: "Looks good." }) }), null, [], 99_000);
    expect(chipTooltip(done, false).split("\n")[1]).toBe("Latest: Looks good.");
  });
});

describe("truncateText", () => {
  it("keeps short text, cuts long text at a word break when close, else mid-word", () => {
    expect(truncateText("  Looks\n good ", 28)).toBe("Looks good");
    expect(truncateText("Reviewing the auth middleware now", 28)).toBe("Reviewing the auth…");
    expect(truncateText("Reviewing the authentication middleware", 28)).toBe("Reviewing the authenticatio…");
    expect(truncateText("Supercalifragilisticexpialidocious!", 10)).toBe("Supercali…");
    expect(truncateText("a".repeat(28), 28)).toBe("a".repeat(28));
  });
});
