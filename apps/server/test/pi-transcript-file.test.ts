/**
 * I-054: a closed sub-agent's conversation is read from its pi session file (no process).
 */
import { describe, expect, it } from "vitest";
import { transcriptFromPiSession } from "../src/harness/pi/transcript-file.js";

const line = (o: unknown) => JSON.stringify(o);

describe("transcriptFromPiSession", () => {
  it("reads the active branch: messages, tool results, displayed custom messages", () => {
    const content = [
      line({ type: "session", version: 3, id: "s", cwd: "/x" }),
      line({ type: "message", id: "1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } }),
      line({ type: "message", id: "old", parentId: "1", message: { role: "assistant", content: [{ type: "text", text: "abandoned" }], timestamp: 2 } }),
      line({
        type: "message",
        id: "2",
        parentId: "1",
        message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } }], timestamp: 3 },
      }),
      line({ type: "message", id: "3", parentId: "2", message: { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "a.txt" }] } }),
      line({ type: "custom_message", id: "4", parentId: "3", customType: "agent-teams", content: "from main", display: true, timestamp: "2026-01-01T00:00:00Z" }),
      line({ type: "message", id: "5", parentId: "4", message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 5 } }),
      '{"type":"message","id":"6","parentId":"5","mess', // partial line being written
    ].join("\n");
    const t = transcriptFromPiSession(content);
    expect(t.messages.map((m) => m.role)).toEqual(["user", "assistant", "notice", "assistant"]);
    expect(JSON.stringify(t.messages)).not.toContain("abandoned");
    expect(t.toolResults.t1).toMatchObject({ toolName: "bash", output: "a.txt", status: "done" });
    expect(t.messages[2]).toMatchObject({ role: "notice", text: "from main" });
  });
});
