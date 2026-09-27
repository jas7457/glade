import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parsePiSessionText, piSessionReader } from "../src/harness/pi/session-reader.js";

const line = (o: object) => JSON.stringify(o);
const msg = (id: string, parentId: string | null, message: object) =>
  line({ type: "message", id, parentId, timestamp: "2026-09-26T10:00:00.000Z", message });

const FIXTURE = [
  line({ type: "session", version: 3, id: "abc", timestamp: "2026-09-26T10:00:00.000Z", cwd: "/tmp/x" }),
  line({ type: "model_change", id: "e0", parentId: null, timestamp: "t", provider: "anthropic", modelId: "m" }),
  line({ type: "session_info", id: "e1", parentId: "e0", timestamp: "t", name: "first name" }),
  msg("e2", "e1", { role: "user", content: [{ type: "text", text: "Add a new toolbar button" }], timestamp: 1 }),
  msg("e3", "e2", {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "secret plan" },
      { type: "text", text: "Sure, adding the button." },
      { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
    ],
    timestamp: 2,
  }),
  msg("e4", "e3", { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "tooloutput" }], isError: false }),
  // An abandoned branch from e3 …
  msg("e5", "e4", { role: "user", content: "abandoned branch words", timestamp: 3 }),
  // … and the active one (last line = leaf).
  line({ type: "session_info", id: "e6", parentId: "e4", timestamp: "t", name: "Toolbar button" }),
  msg("e7", "e6", { role: "user", content: "make it blue", timestamp: 4 }),
  '{"type":"message","id":"e8","parentId":"e7","timestamp":"t","message":{"role":"assis', // partial write
].join("\n");

describe("pi session reader", () => {
  it("extracts user/assistant text of the active branch only", () => {
    const text = parsePiSessionText(FIXTURE.split("\n").slice(0, -1).join("\n"));
    expect(text.name).toBe("Toolbar button");
    expect(text.messages).toEqual([
      { role: "user", text: "Add a new toolbar button", timestamp: 1 },
      { role: "assistant", text: "Sure, adding the button.", timestamp: 2 },
      { role: "user", text: "make it blue", timestamp: 4 },
    ]);
  });

  it("ignores a partially written last line", () => {
    const text = parsePiSessionText(FIXTURE);
    expect(text.messages.map((m) => m.text)).not.toContain("abandoned branch words");
    expect(text.messages).toHaveLength(3);
  });

  it("parses entries with unusual key order", () => {
    const text = parsePiSessionText(
      [line({ id: "a", type: "message", parentId: null, message: { role: "user", content: "hello there", timestamp: 5 } })].join("\n"),
    );
    expect(text.messages).toEqual([{ role: "user", text: "hello there", timestamp: 5 }]);
  });

  const dir = mkdtempSync(join(tmpdir(), "pi-ui-reader-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("stats and reads files; missing files are null", async () => {
    const file = join(dir, "s.jsonl");
    writeFileSync(file, FIXTURE);
    expect(await piSessionReader.stat(file)).toMatchObject({ size: FIXTURE.length });
    expect((await piSessionReader.read(file))?.messages).toHaveLength(3);
    expect(await piSessionReader.stat(join(dir, "missing.jsonl"))).toBeNull();
    expect(await piSessionReader.read(join(dir, "missing.jsonl"))).toBeNull();
  });
});
