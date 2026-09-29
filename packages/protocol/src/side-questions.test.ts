import { describe, expect, it } from "vitest";
import { buildSideQuestionPrompt, sideQuestionNote, SIDE_QUESTION_LIMITS } from "./side-questions.js";
import type { Transcript } from "./transcript.js";

const user = (id: string, text: string, timestamp = 1) => ({ id, role: "user" as const, content: [{ type: "text" as const, text }], timestamp });

describe("buildSideQuestionPrompt", () => {
  it("serializes the conversation (tools cut, private shell and dismissed cards left out) then the question", () => {
    const t: Transcript = {
      messages: [
        user("u1", "fix the build"),
        {
          id: "a1",
          role: "assistant",
          content: [
            { type: "thinking", text: "hmm" },
            { type: "toolCall", id: "c1", name: "bash", kind: "shell", input: { command: "pnpm build" }, args: { command: "pnpm build" } },
          ],
          timestamp: 2,
          streaming: true,
        },
        { id: "sh1", role: "shell", command: "cat .env", shared: false, running: false, output: "SECRET", exitCode: 0, cancelled: false, truncated: false, timestamp: 3 },
        { id: "s1", role: "side", question: "old q", answer: "old a", status: "done", timestamp: 4 },
        { id: "s2", role: "side", question: "gone", answer: "x", status: "done", timestamp: 5, dismissed: true },
      ],
      toolResults: { c1: { toolCallId: "c1", toolName: "bash", status: "running", output: "x".repeat(5000) } },
    };
    const prompt = buildSideQuestionPrompt(t, " is it done? ");
    expect(prompt).toContain("USER:\nfix the build");
    expect(prompt).toContain('[tool bash {"command":"pnpm build"} → running]');
    expect(prompt).toContain("(thinking) hmm"); // the running turn's thinking is included
    expect(prompt).toContain("[still writing…]");
    expect(prompt).toContain(`[${5000 - SIDE_QUESTION_LIMITS.toolOutputChars} more characters]`);
    expect(prompt).not.toContain("SECRET");
    expect(prompt).toContain("SIDE QUESTION (not seen by the agent): old q\nSIDE ANSWER: old a");
    expect(prompt).not.toContain("gone");
    expect(prompt.endsWith("Side question: is it done?")).toBe(true);
  });

  it("keeps the newest turns when the conversation is long", () => {
    const t: Transcript = { messages: Array.from({ length: 50 }, (_, i) => user(`u${i}`, `message ${i} ${"y".repeat(100)}`)), toolResults: {} };
    const prompt = buildSideQuestionPrompt(t, "q", 1000);
    expect(prompt).toContain("[… earlier conversation omitted …]");
    expect(prompt).toContain("message 49");
    expect(prompt).not.toContain("message 1 ");
    expect(prompt.length).toBeLessThan(1300);
  });

  it("says so when there's nothing yet", () => {
    expect(buildSideQuestionPrompt({ messages: [], toolResults: {} }, "q")).toContain("(The conversation is empty so far.)");
  });
});

describe("sideQuestionNote", () => {
  it("quotes the question with the answer", () => {
    expect(sideQuestionNote({ question: " why? ", answer: "Because.\n" })).toBe('About my side question "why?":\n\nBecause.');
    expect(sideQuestionNote({ question: "why?", answer: "" })).toBe("why?");
  });
});
