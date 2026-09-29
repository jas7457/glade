import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage, ContentBlock, Transcript } from "@glade/protocol";
import { DEFAULT_GROUPING_OPTIONS, groupTranscript } from "./grouping";
import { centeredScrollTop, findJumpTarget, flashElement, jumpElement, pendingJump, requestJump, takeJump } from "./jump-to-message";

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

describe("centeredScrollTop", () => {
  it("centers, clamps, and top-aligns tall elements", () => {
    expect(centeredScrollTop(1000, 100, 600, 5000)).toBe(750);
    expect(centeredScrollTop(100, 100, 600, 5000)).toBe(0);
    expect(centeredScrollTop(4900, 100, 600, 5000)).toBe(4400);
    expect(centeredScrollTop(1000, 900, 600, 5000)).toBe(976);
  });
});

describe("jumpElement / flashElement", () => {
  it("picks the turn part or the user bubble and flashes it", () => {
    const column = document.createElement("div");
    column.innerHTML = `<div data-role="user"><img><div class="bubble">hi</div></div><div data-role="assistant"><p>a</p><p class="b">b</p></div>`;
    const bubble = jumpElement(column, { messageId: "u", itemIndex: 0, partIndex: null })!;
    expect(bubble.className).toBe("bubble");
    const part = jumpElement(column, { messageId: "a", itemIndex: 1, partIndex: 1 })!;
    expect(part.className).toBe("b");
    expect(jumpElement(column, { messageId: "x", itemIndex: 5, partIndex: null })).toBeNull();
    flashElement(part);
    expect(part.classList.contains("pi-jump-highlight")).toBe(true);
  });
});
