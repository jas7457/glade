import { describe, expect, it } from "vitest";
import { applyAgentEvent } from "./reducer.js";
import { buildSideQuestionPrompt, sideQuestionNote, sideQuestionPrompt, sideQuestionStreaming, SIDE_QUESTION_LIMITS, type SideQuestionMessage } from "./side-questions.js";
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

  it("a long conversation keeps its start, the user's messages from the middle and the newest part (I-156)", () => {
    const t: Transcript = {
      messages: Array.from({ length: 200 }, (_, i) =>
        i % 2 === 0 ? user(`u${i}`, `ask ${i} ${"y".repeat(100)}`) : { id: `a${i}`, role: "assistant" as const, content: [{ type: "text" as const, text: `reply ${i} ${"z".repeat(300)}` }], timestamp: 1 },
      ),
      toolResults: {},
    };
    const { prompt, partial } = sideQuestionPrompt(t, "q", { maxChars: 8000 });
    expect(partial).toBe(true);
    expect(prompt).toContain("ask 0 "); // the start
    expect(prompt).toContain("reply 1 ");
    expect(prompt).toContain("reply 199 "); // the newest
    expect(prompt).toMatch(/earlier messages omitted; the user's messages from that part/);
    expect(prompt).toContain("ask 150 "); // a user message from the middle…
    expect(prompt).not.toContain("reply 101 "); // …but not the agent's
    expect(prompt.length).toBeLessThan(8300);
    // The old string-only entry point still works.
    expect(buildSideQuestionPrompt(t, "q", 8000)).toBe(prompt);
  });

  it("isn't partial when everything fits", () => {
    const t: Transcript = { messages: [user("u1", "hi")], toolResults: {} };
    expect(sideQuestionPrompt(t, "q")).toEqual({ prompt: "<conversation>\nUSER:\nhi\n</conversation>\n\nSide question: q", partial: false });
  });

  it("a follow-up gets the card's earlier questions and answers, not duplicated in the conversation (I-156)", () => {
    const thread: SideQuestionMessage = {
      id: "s1",
      role: "side",
      question: "first q",
      answer: "first a",
      status: "done",
      timestamp: 2,
      followUps: [{ id: "s2", question: "second q", answer: "second a", status: "done", timestamp: 3 }],
    };
    const other: SideQuestionMessage = { id: "s3", role: "side", question: "other q", answer: "other a", status: "done", timestamp: 4, followUps: [{ id: "s4", question: "other f", answer: "other fa", status: "done", timestamp: 5 }] };
    const t: Transcript = { messages: [user("u1", "hi"), thread, other], toolResults: {} };
    const { prompt } = sideQuestionPrompt(t, " and then? ", { threadId: "s1" });
    const [conversation, rest] = prompt.split("</conversation>");
    expect(conversation).not.toContain("first q");
    expect(conversation).toContain("SIDE ANSWER: other fa"); // other cards' follow-ups are context too
    expect(rest).toContain("<side_thread>");
    expect(rest).toContain("SIDE QUESTION: first q\nSIDE ANSWER: first a\n\nSIDE QUESTION: second q\nSIDE ANSWER: second a");
    expect(prompt.endsWith("Follow-up side question: and then?")).toBe(true);
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

  it("passes on the whole thread, leaving out questions without an answer (I-156)", () => {
    const followUps = [
      { id: "f1", question: "and b?", answer: "B.", status: "done" as const, timestamp: 2 },
      { id: "f2", question: "failed", answer: "", status: "error" as const, timestamp: 3 },
    ];
    expect(sideQuestionNote({ question: "a?", answer: "A.", followUps })).toBe("About my side questions:\n\n**Q:** a?\n\nA.\n\n**Q:** and b?\n\nB.");
    expect(sideQuestionNote({ question: "a?", answer: "", followUps: followUps.slice(0, 1) })).toBe('About my side question "and b?":\n\nB.');
  });
});

describe("side question follow-ups fold into their card (I-156)", () => {
  it("start with parentId appends a follow-up; its deltas and end update it, not the card", () => {
    const t = [
      { type: "side_start", id: "s", question: "q", at: 1 },
      { type: "side_end", id: "s", status: "done", answer: "a", at: 2 },
      { type: "side_start", id: "f", question: "more?", parentId: "s", partialContext: true, model: "p/m", at: 3 },
      { type: "side_start", id: "f", question: "more?", parentId: "s", at: 3 }, // duplicate: ignored
      { type: "side_delta", id: "f", delta: "Y" },
      { type: "side_delta", id: "f", delta: "es" },
    ].reduce((acc, e) => applyAgentEvent(acc, e as Parameters<typeof applyAgentEvent>[1]), { messages: [], toolResults: {} } as Transcript);
    const card = t.messages[0] as SideQuestionMessage;
    expect(t.messages).toHaveLength(1);
    expect(card).toMatchObject({ answer: "a", status: "done", followUps: [{ id: "f", question: "more?", answer: "Yes", status: "streaming", partialContext: true, model: "p/m", timestamp: 3 }] });
    expect(sideQuestionStreaming(card)).toBe(true);
    const ended = applyAgentEvent(t, { type: "side_end", id: "f", status: "error", error: "boom", at: 4 });
    const done = ended.messages[0] as SideQuestionMessage;
    expect(done.followUps![0]).toMatchObject({ status: "error", error: "boom", endedAt: 4, answer: "Yes" });
    expect(done.endedAt).toBe(2);
    expect(sideQuestionStreaming(done)).toBe(false);
    // A follow-up of an unknown card is dropped.
    expect(applyAgentEvent(ended, { type: "side_start", id: "x", question: "?", parentId: "nope" })).toBe(ended);
  });
});
