/** I-054: what a sub-agent tab shows from `SessionSummary.agent`. */
import { describe, expect, it } from "vitest";
import type { SessionAgentState } from "@glade/protocol";
import { makeSession } from "@/test/fixtures";
import { agentDisplay } from "./agent-status";

const agent = (over: Partial<SessionAgentState> = {}): SessionAgentState => ({
  status: "idle",
  agent: null,
  task: "Say hello",
  keepOpenReason: null,
  userEngaged: false,
  closing: false,
  doneAt: null,
  result: null,
  ...over,
});

describe("agentDisplay", () => {
  it("is null for sessions that aren't sub-agents", () => {
    expect(agentDisplay(makeSession({ id: "m" }))).toBeNull();
  });

  it("maps states: working, needs input, done, closing, stopped", () => {
    const kind = (status: "idle" | "working" | "blocked", a: SessionAgentState) => agentDisplay(makeSession({ id: "a", status, agent: a }))!.kind;
    expect(kind("working", agent({ status: "working" }))).toBe("working");
    expect(kind("blocked", agent({ status: "working" }))).toBe("blocked");
    expect(kind("idle", agent({ status: "done", doneAt: 1 }))).toBe("done");
    expect(kind("working", agent({ status: "working", closing: true }))).toBe("closing");
    expect(kind("idle", agent({ status: "closed" }))).toBe("closed");
    expect(kind("idle", agent())).toBe("idle");
  });

  it("puts name, task, keep-open reason and result in the tooltip", () => {
    const d = agentDisplay(
      makeSession({
        id: "a",
        title: "writer",
        agent: agent({ status: "done", agent: "scout", keepOpenReason: "apply feedback", result: "Draft ready." }),
      }),
    )!;
    expect(d.tooltip).toBe("writer (scout) — Done\nKept open for: apply feedback\nTask: Say hello\nResult: Draft ready.");
  });
});
