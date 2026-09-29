import { describe, expect, it } from "vitest";
import { applyMention, findMention, mentionText, splitMentions } from "./parse";

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

describe("splitMentions (I-092)", () => {
  const join = (segs: ReturnType<typeof splitMentions>) => segs.map((s) => (s.type === "text" ? s.text : s.raw)).join("");

  it("finds files, folders and quoted paths; the text round-trips", () => {
    const text = 'look at @src/app.ts and @docs/ plus @"my docs/read me.md", thanks';
    const segs = splitMentions(text);
    expect(segs.filter((s) => s.type === "mention")).toEqual([
      { type: "mention", raw: "@src/app.ts", path: "src/app.ts", kind: "file" },
      { type: "mention", raw: "@docs/", path: "docs", kind: "dir" },
      { type: "mention", raw: '@"my docs/read me.md"', path: "my docs/read me.md", kind: "file" },
    ]);
    expect(join(segs)).toBe(text);
  });
  it("leaves emails, bare words and trailing punctuation alone", () => {
    expect(splitMentions("mail me@example.com or @everyone")).toEqual([{ type: "text", text: "mail me@example.com or @everyone" }]);
    const segs = splitMentions("@README.md, then (@a/b.ts).");
    expect(segs.filter((s) => s.type === "mention").map((s) => (s.type === "mention" ? s.path : ""))).toEqual(["README.md"]);
    expect(join(segs)).toBe("@README.md, then (@a/b.ts).");
    expect(join(splitMentions("line\n@x/y.ts"))).toBe("line\n@x/y.ts");
  });
});
