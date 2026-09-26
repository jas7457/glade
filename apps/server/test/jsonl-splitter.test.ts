import { describe, expect, it } from "vitest";
import { JsonlSplitter } from "../src/harness/pi/rpc-process.js";

function collect(): { lines: string[]; splitter: JsonlSplitter } {
  const lines: string[] = [];
  return { lines, splitter: new JsonlSplitter((l) => lines.push(l)) };
}

describe("JsonlSplitter", () => {
  it("joins records split across chunk boundaries", () => {
    const { lines, splitter } = collect();
    splitter.push(Buffer.from('{"a":1}\n{"b"'));
    expect(lines).toEqual(['{"a":1}']);
    splitter.push(Buffer.from(':2}\n{"c":3}'));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    splitter.push(Buffer.from("\n"));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("strips \\r from \\r\\n line endings and skips empty lines", () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":1}\r\n\r\n{"b":2}\r');
    splitter.push("\n");
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("does not split on U+2028 / U+2029 inside strings", () => {
    const { lines, splitter } = collect();
    const record = JSON.stringify({ text: "one\u2028two\u2029three" });
    splitter.push(Buffer.from(`${record}\n`));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ text: "one\u2028two\u2029three" });
  });

  it("decodes multi-byte UTF-8 characters split across chunks", () => {
    const { lines, splitter } = collect();
    const bytes = Buffer.from(`${JSON.stringify({ text: "héllo 🎉 ✓" })}\n`, "utf8");
    // Feed one byte at a time so every multi-byte sequence is split.
    for (let i = 0; i < bytes.length; i++) splitter.push(bytes.subarray(i, i + 1));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).text).toBe("héllo 🎉 ✓");
  });

  it("flushes a trailing record without newline on end()", () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":1}\n{"b":2}');
    splitter.end();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});
