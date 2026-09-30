/** I-084: linking spawn calls to sub-agents, folding their messages, and the card's state. */
import { describe, expect, it } from "vitest";
import {
  formatAgentFinished,
  formatAgentMessage,
  type AssistantMessage,
  type SessionAgentState,
  type SpawnedAgentRef,
  type ToolResult,
  type Transcript,
  type UserMessage,
} from "@glade/protocol";
import { makeSession } from "@glade/app-core/test/fixtures";
import { linkAgentSpawns, spawnCardState, type SpawnLink } from "./agent-spawns";

const spawnCall = (id: string, agentName: string): AssistantMessage => ({
  id: `a-${id}`,
  role: "assistant",
  timestamp: 1,
  content: [{ type: "toolCall", id, name: "spawn_agent", kind: "task", input: { agentName, description: `do ${agentName}` }, args: {} }],
});
const user = (id: string, text: string, timestamp = 1): UserMessage => ({ id, role: "user", content: [{ type: "text", text }], timestamp });
const ref = (name: string, sessionId: string, spawnedAt: number, extra: Partial<SpawnedAgentRef> = {}): SpawnedAgentRef => ({ name, sessionId, spawnedAt, ...extra });
const done: ToolResult = { toolCallId: "", toolName: "spawn_agent", status: "done", output: "" };
const t = (messages: Transcript["messages"], toolResults: Transcript["toolResults"] = {}): Transcript => ({ messages, toolResults });

describe("linkAgentSpawns", () => {
  it("links calls to agents by name, aligned from the end, and folds later messages into the card", () => {
    const transcript = t([
      spawnCall("c1", "reviewer"),
      user("u1", formatAgentFinished("reviewer", "First review.")),
      spawnCall("c2", "reviewer"),
      spawnCall("c3", "tests"),
      user("u2", formatAgentMessage("tests", "Halfway.")),
      user("u3", formatAgentFinished("reviewer", "Second review.")),
      user("u4", formatAgentFinished("ghost", "Unknown agent.")),
      user("u5", "plain user text"),
    ]);
    // Only the last two reviewer agents are known (e.g. an older one's record is gone).
    const links = linkAgentSpawns(transcript, [ref("reviewer", "r2", 20), ref("tests", "t1", 30), ref("reviewer", "r1", 10)]);
    expect(links.byCall.get("c1")!.ref.sessionId).toBe("r1");
    expect(links.byCall.get("c2")!.ref.sessionId).toBe("r2");
    expect(links.byCall.get("c3")!.ref.sessionId).toBe("t1");
    expect(links.byCall.get("c1")!.messages.map((m) => m.id)).toEqual(["u1"]);
    expect(links.byCall.get("c2")!.messages.map((m) => m.body)).toEqual(["Second review."]);
    expect(links.byCall.get("c3")!.messages.map((m) => m.kind)).toEqual(["message"]);
    // Unknown agents and the user's words stay in the transcript.
    expect([...links.hidden].sort()).toEqual(["u1", "u2", "u3"]);
  });

  it("aligns from the end when history lost older spawns, and skips errored calls", () => {
    const transcript = t([spawnCall("c1", "a"), spawnCall("c2", "a")], { c1: done, c2: { ...done, status: "error" } });
    const links = linkAgentSpawns(transcript, [ref("a", "old", 1), ref("a", "new", 2)]);
    expect(links.byCall.get("c1")!.ref.sessionId).toBe("new");
    expect(links.byCall.has("c2")).toBe(false);
  });

  it("links a native sub-agent to the call that started it, by id (I-188)", () => {
    const task: AssistantMessage = {
      id: "a-x",
      role: "assistant",
      timestamp: 1,
      content: [
        { type: "toolCall", id: "task1", name: "Task", kind: "task", input: { description: "Count files" }, args: {} },
        { type: "toolCall", id: "task2", name: "Task", kind: "task", input: { description: "Count more" }, args: {} },
      ],
    };
    const links = linkAgentSpawns(t([task, spawnCall("c1", "a")]), [
      ref("explore", "n2", 2, { toolCallId: "task2", native: true }),
      ref("explore", "n1", 1, { toolCallId: "task1", native: true }),
      ref("a", "s", 3),
    ]);
    expect(links.byCall.get("task1")!.ref.sessionId).toBe("n1");
    expect(links.byCall.get("task2")!.ref.sessionId).toBe("n2");
    expect(links.byCall.get("c1")!.ref.sessionId).toBe("s");
  });

  it("links nothing without refs; messages before any spawn stay", () => {
    expect(linkAgentSpawns(t([spawnCall("c1", "a")]), undefined).byCall.size).toBe(0);
    const links = linkAgentSpawns(t([user("u0", formatAgentFinished("a", "x")), spawnCall("c1", "a")]), [ref("a", "s", 1)]);
    expect(links.hidden.size).toBe(0);
  });
});

const agent = (over: Partial<SessionAgentState> = {}): SessionAgentState => ({
  status: "working",
  agent: null,
  task: "Review the login flow\nin detail",
  keepOpenReason: null,
  userEngaged: false,
  closing: false,
  doneAt: null,
  result: null,
  ...over,
});
const linkOf = (messages: SpawnLink["messages"] = [], extra: Partial<SpawnedAgentRef> = {}): SpawnLink => ({
  ref: ref("reviewer", "s1", 1_000, { displayName: "Maya", color: "violet", ...extra }),
  messages,
});

describe("spawnCardState", () => {
  it("while the agent runs: its session's status, task and elapsed time", () => {
    const session = makeSession({ id: "s1", kind: "subagent", agentName: "reviewer", agentDisplayName: "Maya", agentColor: "violet", status: "working", createdAt: 1_000, agent: agent() });
    const s = spawnCardState({ link: linkOf(), session, transcript: null, description: "Review the login flow", callActive: false, now: 61_000 });
    expect(s).toMatchObject({
      identity: { displayName: "Maya", role: "reviewer", color: "violet" },
      kind: "working",
      running: true,
      elapsedMs: 60_000,
      task: "Review the login flow\nin detail",
      latest: "Starting…",
      report: null,
    });
  });

  it("after it closed: done with the report from its finished message", () => {
    const finished = { kind: "finished" as const, from: "reviewer", body: "## Result\nAll **good**.", id: "u1", timestamp: 31_000 };
    const s = spawnCardState({ link: linkOf([finished]), session: undefined, transcript: null, description: "Review", callActive: false, now: 99_000 });
    expect(s).toMatchObject({ identity: { displayName: "Maya", color: "violet" }, kind: "done", label: "Done", elapsedMs: 30_000, latest: "All good.", report: "## Result\nAll **good**.", task: "Review" });
  });

  it("an exited agent is failed with the reason; old agents fall back to their name", () => {
    const exited = { kind: "exited" as const, from: "reviewer", body: "Process crashed.", id: "u1", timestamp: 5_000 };
    const s = spawnCardState({ link: linkOf([exited], { displayName: undefined, color: undefined }), session: undefined, transcript: null, description: undefined, callActive: false, now: 9_000 });
    expect(s).toMatchObject({ kind: "failed", label: "Exited", attention: "danger", latest: "Process crashed.", note: "Process crashed.", report: null });
    expect(s.identity.displayName).toBe("reviewer");
    expect(s.identity.role).toBeNull();
  });

  it("needs input shows the attention state", () => {
    const session = makeSession({ id: "s1", kind: "subagent", agentName: "reviewer", status: "blocked", createdAt: 1_000, agent: agent() });
    const s = spawnCardState({ link: linkOf(), session, transcript: null, description: undefined, callActive: false, now: 2_000 });
    expect(s).toMatchObject({ kind: "blocked", attention: "warning", latest: "Waiting for your input" });
  });

  it("shows Thinking… between steps, Starting… only before anything happened (I-130)", () => {
    const session = makeSession({ id: "s1", kind: "subagent", agentName: "reviewer", status: "working", createdAt: 1_000, agent: agent() });
    const call = { type: "toolCall" as const, id: "t1", name: "bash", kind: "shell" as const, input: { command: "ls" }, args: { command: "ls" } };
    const toolTurn: AssistantMessage = { id: "a1", role: "assistant", content: [call], timestamp: 1 };
    const results = { t1: { toolCallId: "t1", toolName: "bash", status: "done" as const, output: "" } };
    const card = (transcript: Transcript | null) => spawnCardState({ link: linkOf(), session, transcript, description: undefined, callActive: false, now: 2_000 }).latest;
    expect(card(null)).toBe("Starting…");
    expect(card(t([user("u0", "Task")]))).toBe("Starting…");
    expect(card(t([{ id: "a0", role: "assistant", content: [], timestamp: 1, streaming: true }]))).toBe("Thinking…");
    expect(card(t([toolTurn, { id: "a2", role: "assistant", content: [], timestamp: 2, streaming: true }], results))).toBe("Thinking…");
    expect(card(t([toolTurn, { id: "a2", role: "assistant", content: [{ type: "thinking", text: "…" }], timestamp: 2, streaming: true }], results))).toBe("Thinking…");
    expect(card(t([toolTurn], results))).toBe("Ran ls");
  });

});
