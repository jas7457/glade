import { describe, expect, it } from "vitest";
import { agentLabel, agentOpenNote, formatAgentExited, formatAgentFinished, formatAgentMessage, parseAgentMessage } from "./agent-messages.js";

const open = { name: "harness-core", closing: false, userEngaged: false, keepOpenReason: null, idleMinutes: 10 };

describe("agent message texts", () => {
  it("formats exactly what agent-teams expects", () => {
    expect(formatAgentMessage("dialogs", "hi")).toBe("[agent-teams] message from dialogs:\nhi");
    expect(formatAgentExited("x", "crashed")).toBe("[agent-teams] x exited:\ncrashed");
    expect(formatAgentFinished("x", "done")).toBe("[agent-teams] x finished:\ndone");
    expect(agentOpenNote({ ...open, closing: true })).toBe("");
    expect(agentOpenNote(open)).toBe(
      "\n\n(harness-core is still open. If that follow-up is still planned, send it now with message_agent. Otherwise call close_agent. It closes automatically after 10 idle minutes.)",
    );
    expect(agentOpenNote({ ...open, keepOpenReason: "review" })).toContain("is still open — kept open for: review.");
    expect(agentOpenNote({ ...open, userEngaged: true })).toBe(
      "\n\n(harness-core's tab stays open because the user has typed in it. Leave it to the user.)",
    );
  });
});

describe("parseAgentMessage", () => {
  it("parses a message with a multi-line body", () => {
    expect(parseAgentMessage(formatAgentMessage("main", "line 1\n\n## Two\n- a"))).toEqual({ kind: "message", from: "main", body: "line 1\n\n## Two\n- a" });
  });

  it("parses finished without a note", () => {
    expect(parseAgentMessage(formatAgentFinished("tool-kinds", "## Summary\n\nAll **done**."))).toEqual({
      kind: "finished",
      from: "tool-kinds",
      body: "## Summary\n\nAll **done**.",
    });
  });

  it("splits off the still-open note", () => {
    const text = formatAgentFinished("harness-core", "Did it.\n\n(see notes)", agentOpenNote({ ...open, keepOpenReason: "follow-up (maybe)" }));
    const parsed = parseAgentMessage(text);
    expect(parsed?.body).toBe("Did it.\n\n(see notes)");
    expect(parsed?.note).toBe(
      "harness-core is still open — kept open for: follow-up (maybe). If that follow-up is still planned, send it now with message_agent. Otherwise call close_agent. It closes automatically after 10 idle minutes.",
    );
  });

  it("splits off the user-engaged note", () => {
    const parsed = parseAgentMessage(formatAgentFinished("a", "ok", agentOpenNote({ ...open, name: "a", userEngaged: true })));
    expect(parsed).toEqual({ kind: "finished", from: "a", body: "ok", note: "a's tab stays open because the user has typed in it. Leave it to the user." });
  });

  it("parses exited", () => {
    expect(parseAgentMessage(formatAgentExited("x", "Process ended without calling report_done (crashed)."))).toEqual({
      kind: "exited",
      from: "x",
      body: "Process ended without calling report_done (crashed).",
    });
  });

  it("accepts an empty body", () => {
    expect(parseAgentMessage("[agent-teams] x finished:")).toEqual({ kind: "finished", from: "x", body: "" });
  });

  it("ignores text that only mentions agent-teams", () => {
    expect(parseAgentMessage("Look at this: [agent-teams] x finished:\nfoo")).toBeNull();
    expect(parseAgentMessage("\n[agent-teams] x finished:\nfoo")).toBeNull();
    expect(parseAgentMessage("[agent-teams] x did something:\nfoo")).toBeNull();
    expect(parseAgentMessage("[agent-teams] x finished: inline")).toBeNull();
    expect(parseAgentMessage("hello")).toBeNull();
  });
});

describe("display names in headers (I-120)", () => {
  it("formats Leo (code-name) headers and notes", () => {
    expect(formatAgentFinished("t3-research", "done", "", "Leo")).toBe("[agent-teams] Leo (t3-research) finished:\ndone");
    expect(formatAgentMessage("t3-research", "hi", "Leo")).toBe("[agent-teams] message from Leo (t3-research):\nhi");
    expect(formatAgentExited("t3-research", "crashed", "Leo 2")).toBe("[agent-teams] Leo 2 (t3-research) exited:\ncrashed");
    expect(formatAgentMessage("main", "hi", null)).toBe("[agent-teams] message from main:\nhi");
    expect(agentLabel("x", "")).toBe("x");
    expect(agentOpenNote({ ...open, displayName: "Leo" })).toMatch(/^\n\n\(Leo \(harness-core\) is still open\. /);
  });

  it("parses new headers, keeping the code name as `from`", () => {
    expect(parseAgentMessage(formatAgentMessage("t3-research", "hi", "Leo"))).toEqual({ kind: "message", from: "t3-research", displayName: "Leo", body: "hi" });
    expect(parseAgentMessage(formatAgentExited("t3-research", "gone", "Leo 2"))).toEqual({
      kind: "exited",
      from: "t3-research",
      displayName: "Leo 2",
      body: "gone",
    });
    const note = agentOpenNote({ ...open, displayName: "Remy", keepOpenReason: "review (maybe)" });
    const parsed = parseAgentMessage(formatAgentFinished("harness-core", "Did it (really).", note, "Remy"));
    expect(parsed).toMatchObject({ kind: "finished", from: "harness-core", displayName: "Remy", body: "Did it (really)." });
    expect(parsed?.note).toMatch(/^Remy \(harness-core\) is still open — kept open for: review \(maybe\)\./);
    const engaged = parseAgentMessage(formatAgentFinished("a", "ok", agentOpenNote({ ...open, name: "a", displayName: "Ivy", userEngaged: true }), "Ivy"));
    expect(engaged?.note).toBe("Ivy (a)'s tab stays open because the user has typed in it. Leave it to the user.");
  });

  it("still parses old headers", () => {
    expect(parseAgentMessage("[agent-teams] t3-research finished:\nok")).toEqual({ kind: "finished", from: "t3-research", body: "ok" });
    expect(parseAgentMessage("[agent-teams] message from main:\nok")).toEqual({ kind: "message", from: "main", body: "ok" });
    expect(parseAgentMessage("[agent-teams] Leo (t3-research) did something:\nfoo")).toBeNull();
  });
});
