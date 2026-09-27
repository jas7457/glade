import { describe, expect, it } from "vitest";
import type { AssistantMessage, ContentBlock, Transcript } from "@glade/protocol";
import { workingStatus } from "./working";

const running = { isRunning: true, isCompacting: false };
const idle = { isRunning: false, isCompacting: false };

function reply(content: ContentBlock[], streaming = true): AssistantMessage {
  return { id: "a1", role: "assistant", content, timestamp: 0, streaming };
}

function transcript(...messages: AssistantMessage[]): Transcript {
  return { messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }, ...messages], toolResults: {} };
}

describe("workingStatus", () => {
  it("is gone when idle", () => {
    expect(workingStatus(transcript(), idle)).toMatchObject({ mounted: false, visible: false });
    expect(workingStatus(transcript(reply([{ type: "text", text: "hi" }])), idle).mounted).toBe(false);
  });

  it("shows Working… while running with nothing streaming (before the reply, between tool calls)", () => {
    expect(workingStatus(transcript(), running)).toEqual({ mounted: true, visible: true, label: "Working…" });
    const done = reply([{ type: "toolCall", id: "t1", name: "Bash", kind: "shell", input: { command: "ls" }, args: { command: "ls" } }], false);
    expect(workingStatus(transcript(done), running)).toEqual({ mounted: true, visible: true, label: "Working…" });
  });

  it("stays shown while a tool call's arguments stream, and while an empty message starts", () => {
    const t = transcript(reply([{ type: "text", text: "Let me look." }, { type: "toolCall", id: "t1", name: "Bash", kind: "shell", args: undefined }]));
    expect(workingStatus(t, running)).toMatchObject({ visible: true, label: "Working…" });
    expect(workingStatus(transcript(reply([])), running)).toMatchObject({ visible: true, label: "Working…" });
  });

  it("hides (but stays mounted) while reply text streams", () => {
    expect(workingStatus(transcript(reply([{ type: "text", text: "Here" }])), running)).toMatchObject({ mounted: true, visible: false });
    // Whitespace isn't visible text yet.
    expect(workingStatus(transcript(reply([{ type: "text", text: " \n" }])), running).visible).toBe(true);
  });

  it("stays hidden after the final reply until the run ends, but not after tool use", () => {
    const final = { ...reply([{ type: "text", text: "Done." }], false), stopReason: "stop" as const };
    expect(workingStatus(transcript(final), running)).toMatchObject({ mounted: true, visible: false });
    const tools = { ...reply([{ type: "toolCall", id: "t1", name: "Bash", kind: "shell", args: {} }], false), stopReason: "toolUse" as const };
    expect(workingStatus(transcript(tools), running).visible).toBe(true);
    // A new run that starts before its user message arrives: the old reply doesn't hide it.
    expect(workingStatus(transcript({ ...final, timestamp: 1_000 }), { ...running, runStartedAt: 2_000 }).visible).toBe(true);
    expect(workingStatus(transcript({ ...final, timestamp: 3_000 }), { ...running, runStartedAt: 2_000 }).visible).toBe(false);
  });

  it("says Thinking… while hidden (empty/redacted) thinking streams", () => {
    expect(workingStatus(transcript(reply([{ type: "thinking", text: "" }])), running)).toEqual({ mounted: true, visible: true, label: "Thinking…" });
    expect(workingStatus(transcript(reply([{ type: "thinking", text: "x", redacted: true }])), running).label).toBe("Thinking…");
    // Visible thinking has its own "Thinking…" row; this one keeps saying Working….
    expect(workingStatus(transcript(reply([{ type: "thinking", text: "Hmm, the tests…" }])), running).label).toBe("Working…");
  });

  it("says Compacting context… while compacting", () => {
    expect(workingStatus(transcript(), { isRunning: true, isCompacting: true })).toMatchObject({ visible: true, label: "Compacting context…" });
    const final = { ...reply([{ type: "text", text: "Done." }], false), stopReason: "stop" as const };
    expect(workingStatus(transcript(final), { isRunning: true, isCompacting: true }).visible).toBe(true);
  });
});
