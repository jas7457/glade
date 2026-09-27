import { describe, expect, it } from "vitest";
import { TextIndex, makeSnippet, queryTerms, tokenize } from "../src/services/search/text-index.js";
import { cleanSummary, finderPrompt, parseFinderReply, summaryPrompt } from "../src/services/search/finder.js";

describe("tokenize / queryTerms", () => {
  it("lowercases, splits on punctuation and drops stop words from queries", () => {
    expect(tokenize("Fix the slash_menu (I-047) now!")).toEqual(["fix", "the", "slash", "menu", "047", "now"]);
    expect(queryTerms("open the chat where we talked about the new button")).toEqual(["new", "button"]);
    expect(queryTerms("the")).toEqual(["the"]);
  });
});

describe("TextIndex", () => {
  const index = new TextIndex();
  index.set("a", [
    { kind: "title", text: "Casual greeting" },
    { kind: "user", text: "Please add a new button to the toolbar" },
    { kind: "assistant", text: "Added the button with an icon." },
  ]);
  index.set("b", [
    { kind: "title", text: "Button styles" },
    { kind: "user", text: "Change colors of every primary control" },
  ]);
  index.set("c", [
    { kind: "title", text: "Database migration" },
    { kind: "user", text: "Write a migration for the users table. The toolbar is unrelated." },
  ]);

  it("finds a phrase that only appears inside a conversation, with a highlighted snippet", () => {
    const [hit, ...rest] = index.search("users table");
    expect(hit).toMatchObject({ sessionId: "c", kind: "user" });
    expect(rest).toHaveLength(0);
    const { text, highlights } = hit!.snippet;
    expect(highlights.map(([s, e]) => text.slice(s, e))).toEqual(["users", "table"]);
  });

  it("requires every word in `all` mode, any word in `any` mode", () => {
    expect(index.search("button migration").map((h) => h.sessionId)).toEqual([]);
    expect(index.search("button migration", { mode: "any" }).map((h) => h.sessionId).sort()).toEqual(["a", "b", "c"]);
  });

  it("ranks title matches above body matches and matches word prefixes", () => {
    expect(index.search("button").map((h) => h.sessionId)).toEqual(["b", "a"]);
    expect(index.search("tool").map((h) => h.sessionId).sort()).toEqual(["a", "c"]);
    expect(index.search("toolbar button")[0]!.sessionId).toBe("a");
  });

  it("replaces and removes sessions", () => {
    const i = new TextIndex();
    i.set("x", [{ kind: "user", text: "alpha" }]);
    i.set("x", [{ kind: "user", text: "beta" }]);
    expect(i.search("alpha")).toEqual([]);
    expect(i.search("beta")).toHaveLength(1);
    i.remove("x");
    expect(i.search("beta")).toEqual([]);
    expect(i.size).toBe(0);
  });
});

describe("makeSnippet", () => {
  it("centres long text on the first match with ellipses", () => {
    const text = `${"lorem ipsum ".repeat(40)}the needle is here ${"dolor sit ".repeat(40)}`;
    const s = makeSnippet(text, ["needle"]);
    expect(s.text.startsWith("…")).toBe(true);
    expect(s.text.endsWith("…")).toBe(true);
    expect(s.text.length).toBeLessThanOrEqual(163);
    expect(s.highlights).toHaveLength(1);
    const [a, b] = s.highlights[0]!;
    expect(s.text.slice(a, b)).toBe("needle");
  });
  it("collapses whitespace and highlights word prefixes only", () => {
    expect(makeSnippet("a  button\n\nrebutton buttons", ["button"])).toEqual({
      text: "a button rebutton buttons",
      highlights: [
        [2, 8],
        [18, 24],
      ],
    });
  });
});

describe("finder prompt + reply", () => {
  const candidates = [
    { label: "c1", title: "Toolbar", project: "app", updatedAt: 0, summary: "Adds a save button", opening: null, excerpt: null },
    { label: "c2", title: "Other", project: null, updatedAt: 0, summary: null, opening: "hello", excerpt: "matching" },
  ];
  it("lists every candidate with its summary or opening message", () => {
    const p = finderPrompt("the save button chat", candidates, 0);
    expect(p).toContain('c1: "Toolbar" | project app | last active 1970-01-01 | summary: Adds a save button');
    expect(p).toContain('c2: "Other" | no project | last active 1970-01-01 | starts with: hello | matching text: matching');
  });
  it("parses JSON (even wrapped in prose), drops unknown and duplicate labels", () => {
    const labels = new Set(["c1", "c2"]);
    expect(parseFinderReply('Sure: {"matches":[{"id":"c2","reason":"r"},{"id":"c9"},{"id":"c2"}],"confident":true}', labels)).toEqual({
      matches: [{ label: "c2", reason: "r" }],
      confident: true,
    });
    expect(parseFinderReply('{"matches":[],"confident":true}', labels)).toEqual({ matches: [], confident: false });
    expect(parseFinderReply("no idea", labels)).toBeNull();
  });
  it("builds and cleans summaries", () => {
    const p = summaryPrompt("T", [
      { role: "user", text: "first", timestamp: 0 },
      { role: "assistant", text: "early", timestamp: 0 },
      { role: "assistant", text: "last reply", timestamp: 0 },
    ]);
    expect(p).toContain("User: first");
    expect(p).toContain("Assistant (last reply): last reply");
    expect(p).not.toContain("early");
    expect(cleanSummary('\n"Summary: Adds a button."\n')).toBe("Adds a button.");
    expect(cleanSummary("  ")).toBeNull();
  });
});
