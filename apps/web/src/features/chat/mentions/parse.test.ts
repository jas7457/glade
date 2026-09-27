import { describe, expect, it } from "vitest";
import { applyMention, findMention, mentionText } from "./parse";

describe("findMention", () => {
  it("finds @query at the start or after whitespace, ending at the caret", () => {
    expect(findMention("@comp", 5)).toEqual({ start: 0, end: 5, query: "comp" });
    expect(findMention("see @src/a now", 10)).toEqual({ start: 4, end: 10, query: "src/a" });
    expect(findMention("line\n@", 6)).toEqual({ start: 5, end: 6, query: "" });
  });
  it("ignores @ inside words, after the token, or quoted", () => {
    expect(findMention("me@example.com", 14)).toBeNull();
    expect(findMention("@comp done", 10)).toBeNull();
    expect(findMention('@"my docs', 9)).toBeNull();
  });
});

describe("mentionText / applyMention", () => {
  it("quotes paths with spaces and marks folders with /", () => {
    expect(mentionText({ path: "a/b.ts", kind: "file" })).toBe("@a/b.ts");
    expect(mentionText({ path: "src", kind: "dir" })).toBe("@src/");
    expect(mentionText({ path: "my docs/x.md", kind: "file" })).toBe('@"my docs/x.md"');
  });
  it("replaces the token; files add a space, folders keep completing", () => {
    const text = "read @comp please";
    const m = findMention(text, 10)!;
    expect(applyMention(text, m, { path: "Composer.tsx", kind: "file" })).toEqual({ text: "read @Composer.tsx please", caret: 19 });
    expect(applyMention("@s", findMention("@s", 2)!, { path: "src", kind: "dir" })).toEqual({ text: "@src/", caret: 5 });
  });
});
