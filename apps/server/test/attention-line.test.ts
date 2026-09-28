import { describe, expect, it } from "vitest";
import type { ChatMessage, Transcript, UiRequest } from "@glade/protocol";
import { ATTENTION_LINE_MAX, attentionLine, lastSentence } from "../src/services/app/attention-line.js";

const reply = (text: string, extra: Partial<Extract<ChatMessage, { role: "assistant" }>> = {}): ChatMessage => ({
  id: `a${Math.random()}`,
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: 1,
  ...extra,
});
const transcript = (...messages: ChatMessage[]): Transcript => ({ messages, toolResults: {} });

describe("attention line (I-135 notifications)", () => {
  it("prefers the open question", () => {
    const pending: UiRequest[] = [{ id: "u1", kind: "confirm", title: "Delete the branch?", message: "glade/x" }];
    expect(attentionLine(transcript(reply("Done.")), pending, false)).toBe("Delete the branch?: glade/x");
  });
  it("uses the last sentence of the last reply", () => {
    expect(attentionLine(transcript(reply("Old."), reply("I fixed it. **All tests pass.**")), [], false)).toBe("All tests pass.");
  });
  it("uses the error of a failed run", () => {
    expect(attentionLine(transcript(reply("", { stopReason: "error", errorMessage: "Rate limited" })), [], true)).toBe("Rate limited");
  });
  it("is undefined without anything to say", () => {
    expect(attentionLine(null, [], false)).toBeUndefined();
    expect(attentionLine(transcript(), [], false)).toBeUndefined();
  });
  it("strips markdown and clips long lines", () => {
    expect(lastSentence("See `foo` in [the docs](http://x).")).toBe("See foo in the docs.");
    expect(lastSentence("```\ncode\n```")).toBeUndefined();
    const long = lastSentence("x".repeat(500))!;
    expect(long.length).toBe(ATTENTION_LINE_MAX);
    expect(long.endsWith("…")).toBe(true);
  });
});
