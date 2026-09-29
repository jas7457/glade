import { describe, expect, it } from "vitest";
import { formatAgentFinished, formatAgentMessage, type ChatMessage, type UserMessage } from "@glade/protocol";
import { delegatedMessage, taskMessageId } from "./delegated";

const user = (id: string, text: string): UserMessage => ({ id, role: "user", content: [{ type: "text", text }], timestamp: 0 });
const reply = (id: string): ChatMessage => ({ id, role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 0 });

describe("taskMessageId", () => {
  it("is the sub-agent's first prompt", () => {
    expect(taskMessageId([user("t", "Do the thing"), reply("a"), user("u", "and more")])).toBe("t");
  });

  it("prefers the message with the session's task text", () => {
    expect(taskMessageId([user("x", "something else"), user("t", "Do the thing")], "  Do the thing\n")).toBe("t");
    expect(taskMessageId([user("t", "Do the thing")], "a task that isn't here")).toBe("t");
  });

  it("none when the first prompt is an agent message or there are no prompts", () => {
    expect(taskMessageId([user("m", formatAgentMessage("main", "hi"))])).toBeNull();
    expect(taskMessageId([reply("a")])).toBeNull();
  });
});

describe("delegatedMessage", () => {
  it("the task", () => {
    expect(delegatedMessage(user("t", "Fix **it**\n"), "t")).toEqual({ kind: "task", body: "Fix **it**" });
  });

  it("the parent's message_agent messages, without the header", () => {
    expect(delegatedMessage(user("m", formatAgentMessage("main", "Also check the tests")), "t")).toEqual({ kind: "message", body: "Also check the tests" });
  });

  it("not the user's own words, other agents' messages or reports", () => {
    expect(delegatedMessage(user("u", "please stop"), "t")).toBeNull();
    expect(delegatedMessage(user("u", formatAgentMessage("fern", "hi")), "t")).toBeNull();
    expect(delegatedMessage(user("u", formatAgentFinished("kit", "done")), "t")).toBeNull();
  });
});
