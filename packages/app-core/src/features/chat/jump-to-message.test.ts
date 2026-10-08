import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage, ContentBlock, Transcript } from "@glade/protocol";
import { DEFAULT_GROUPING_OPTIONS, groupTranscript } from "./grouping";
import { JUMP_MARGIN, answerPartIndex, findJumpTarget, flashElement, jumpElement, jumpScrollTop, pendingJump, requestJump, takeJump } from "./jump-to-message";

const text = (t: string) => ({ type: "text" as const, text: t });
const call = (id: string): ContentBlock => ({ type: "toolCall", id, name: "Bash", kind: "shell", input: { command: "ls" }, args: { command: "ls" } });
const messages: ChatMessage[] = [
  { id: "h0", role: "user", content: [text("refactor the gateway")], timestamp: 100 },
  { id: "h1", role: "assistant", content: [text("Looking."), call("t1")], timestamp: 200 },
  { id: "h3", role: "assistant", content: [{ type: "thinking", text: "hmm", redacted: false }, text("Split into an adapter.")], timestamp: 400 },
  { id: "h4", role: "user", content: [text("now pagination")], timestamp: 500 },
];
const transcript: Transcript = { messages, toolResults: { t1: { toolCallId: "t1", toolName: "Bash", status: "done", output: "" } } };
const items = groupTranscript(transcript, { isRunning: false }, DEFAULT_GROUPING_OPTIONS);

describe("answerPartIndex (I-206)", () => {
  const part = (type: "text" | "thinking", key: string) => ({ type, key, text: "x", streaming: false }) as const;
  it("is the first text part (of a message when given its key prefix), else the start", () => {
    const parts = [part("thinking", "a:0"), part("text", "a:1"), part("text", "b:0")];
    expect(answerPartIndex(parts)).toBe(1);
    expect(answerPartIndex(parts, "b:", 2)).toBe(2);
    expect(answerPartIndex([part("thinking", "a:0")])).toBe(0);
    expect(answerPartIndex([part("thinking", "a:0"), part("thinking", "b:0")], "b:", 1)).toBe(1);
  });
});

describe("findJumpTarget", () => {
  it("finds a user message's item", () => {
    expect(findJumpTarget(messages, items, { role: "user", timestamp: 500 })).toEqual({ messageId: "h4", itemIndex: 2, partIndex: null });
  });

  it("finds the matched assistant message's text part inside a turn", () => {
    const target = findJumpTarget(messages, items, { role: "assistant", timestamp: 400 })!;
    expect(target).toMatchObject({ messageId: "h3", itemIndex: 1 });
    const turn = items[1]!;
    if (turn.type !== "turn") throw new Error("expected a turn");
    const part = turn.parts[target.partIndex!]!;
    expect(part).toMatchObject({ type: "text", text: "Split into an adapter." });
  });

  it("for a reply's first message without text (a bookmark), lands where the reply's text starts (I-206)", () => {
    const reply: ChatMessage[] = [
      { id: "q", role: "user", content: [text("numbers?")], timestamp: 1 },
      { id: "r1", role: "assistant", content: [{ type: "thinking", text: "let me look", redacted: false }, call("t1")], timestamp: 2 },
      { id: "r2", role: "assistant", content: [call("t2"), text("Revenue is up.")], timestamp: 3 },
    ];
    const results = { t1: { toolCallId: "t1", toolName: "Bash", status: "done" as const, output: "" }, t2: { toolCallId: "t2", toolName: "Bash", status: "done" as const, output: "" } };
    const replyItems = groupTranscript({ messages: reply, toolResults: results }, { isRunning: false }, DEFAULT_GROUPING_OPTIONS);
    const turn = replyItems[1]!;
    if (turn.type !== "turn") throw new Error("expected a turn");
    const target = findJumpTarget(reply, replyItems, { role: "assistant", timestamp: 2 })!;
    expect(target).toMatchObject({ messageId: "r1", itemIndex: 1 });
    expect(turn.parts[target.partIndex!]).toMatchObject({ type: "text", text: "Revenue is up." });
    expect(target.partIndex).toBe(answerPartIndex(turn.parts));
    // A reply without any text: its first part.
    const noText = replyItems.slice(0, 1).concat({ ...turn, parts: turn.parts.filter((p) => p.type !== "text") });
    expect(findJumpTarget(reply, noText, { role: "assistant", timestamp: 2 })).toMatchObject({ partIndex: 0 });
  });

  it("prefers the message with text on a timestamp tie", () => {
    const tied: ChatMessage[] = [
      { id: "a1", role: "assistant", content: [call("t1")], timestamp: 7 },
      { id: "a2", role: "assistant", content: [text("the reply")], timestamp: 7 },
    ];
    const tiedItems = groupTranscript({ messages: tied, toolResults: {} }, { isRunning: false }, DEFAULT_GROUPING_OPTIONS);
    expect(findJumpTarget(tied, tiedItems, { role: "assistant", timestamp: 7 })).toMatchObject({ messageId: "a2" });
  });

  it("returns null when the message isn't loaded or isn't rendered", () => {
    expect(findJumpTarget(messages, items, { role: "user", timestamp: 999 })).toBeNull();
    expect(findJumpTarget(messages, items, { role: "assistant", timestamp: 100 })).toBeNull(); // role must match too
    const hidden = items.filter((i) => !(i.type === "user" && i.message.id === "h4"));
    expect(findJumpTarget(messages, hidden, { role: "user", timestamp: 500 })).toBeNull();
  });
});

describe("pending jump", () => {
  afterEach(() => void (pendingJump.value = null));

  it("is taken once by the matching session", () => {
    requestJump("s1", { role: "user", timestamp: 1 }, 1000);
    expect(takeJump("s2", 1000)).toBeNull();
    expect(takeJump("s1", 1500)).toEqual({ role: "user", timestamp: 1 });
    expect(takeJump("s1", 1500)).toBeNull();
  });

  it("expires", () => {
    requestJump("s1", { role: "user", timestamp: 1 }, 1000);
    expect(takeJump("s1", 20_000)).toBeNull();
    expect(pendingJump.value).toBeNull();
  });
});

describe("jumpScrollTop (I-206)", () => {
  it("puts the element's start near the top with a margin of about 1.5–2 lines", () => {
    expect(JUMP_MARGIN).toBeGreaterThanOrEqual(24);
    expect(JUMP_MARGIN).toBeLessThanOrEqual(32);
    expect(jumpScrollTop(1000, 600, 5000)).toBe(1000 - JUMP_MARGIN);
    expect(jumpScrollTop(1000, 600, 5000, { margin: 24 })).toBe(976);
  });

  it("stays below anything overlaying the top", () => {
    expect(jumpScrollTop(1000, 600, 5000, { topInset: 44, margin: 24 })).toBe(932);
  });

  it("clamps at the start and at the end of the transcript", () => {
    expect(jumpScrollTop(10, 600, 5000)).toBe(0);
    // A message near the end can't reach the top: stop where the transcript ends.
    expect(jumpScrollTop(4900, 600, 5000)).toBe(4400);
    // Content shorter than the viewport: no scrolling.
    expect(jumpScrollTop(300, 600, 400)).toBe(0);
  });

  it("aligns tall elements the same way (their start shows)", () => {
    expect(jumpScrollTop(1000, 600, 9000, { margin: 24 })).toBe(976);
  });

  it("rounds", () => {
    expect(jumpScrollTop(1000.6, 600, 5000, { margin: 24 })).toBe(977);
  });
});

describe("jumpElement / flashElement", () => {
  it("picks the turn part or the user bubble and flashes it", () => {
    const column = document.createElement("div");
    column.innerHTML = `<div data-role="user"><img><div class="bubble">hi</div><time data-aux="time">9:00</time></div><div data-role="assistant"><p>a</p><p class="b">b</p></div>`;
    const bubble = jumpElement(column, { messageId: "u", itemIndex: 0, partIndex: null })!;
    expect(bubble.className).toBe("bubble");
    const part = jumpElement(column, { messageId: "a", itemIndex: 1, partIndex: 1 })!;
    expect(part.className).toBe("b");
    expect(jumpElement(column, { messageId: "x", itemIndex: 5, partIndex: null })).toBeNull();
    // A reply's ribbon slot (data-aux) doesn't count as a part (I-206).
    column.children[1]!.insertAdjacentHTML("afterbegin", `<div data-aux="ribbon"></div>`);
    expect(jumpElement(column, { messageId: "a", itemIndex: 1, partIndex: 1 })!.className).toBe("b");
    flashElement(part);
    expect(part.classList.contains("pi-jump-highlight")).toBe(true);
  });
});
