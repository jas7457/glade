/** I-080/I-084: sub-agent chips (status, time, model, activity, identity, truncation). */
import { describe, expect, it } from "vitest";
import type { ContentBlock, ModelInfo, SessionAgentState, ToolResult, Transcript } from "@glade/protocol";
import { makeSession } from "@/test/fixtures";
import { agentChip, CHIP_TEXT_MAX, chipKind, latestActivity, shortModelName, truncateText } from "./agent-chips";

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
  it("shows the running tool call, else the latest reply line or finished call", () => {
    expect(latestActivity(null)).toBe("");
    expect(latestActivity(transcript([{ type: "text", text: "Checking." }, bash], { t1: result("running") }))).toBe("Running pnpm test");
    expect(latestActivity(transcript([bash], { t1: result("done") }))).toBe("Ran pnpm test");
    expect(latestActivity(transcript([bash, { type: "text", text: "All green.\n\n**Tests pass.**" }], { t1: result("done") }))).toBe("Tests pass.");
    // A call still streaming its args (no result yet) counts as running.
    expect(latestActivity(transcript([bash], {}, true))).toBe("Running pnpm test");
  });
});

describe("agentChip", () => {
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
    expect(named.identity).toEqual({ displayName: "Maya", role: "reviewer", color: "teal" });
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

describe("truncateText", () => {
  it("keeps short text, cuts long text at a word break when close, else mid-word", () => {
    expect(truncateText("  Looks\n good ", 28)).toBe("Looks good");
    expect(truncateText("Reviewing the auth middleware now", 28)).toBe("Reviewing the auth…");
    expect(truncateText("Reviewing the authentication middleware", 28)).toBe("Reviewing the authenticatio…");
    expect(truncateText("Supercalifragilisticexpialidocious!", 10)).toBe("Supercali…");
    expect(truncateText("a".repeat(28), 28)).toBe("a".repeat(28));
  });
});
