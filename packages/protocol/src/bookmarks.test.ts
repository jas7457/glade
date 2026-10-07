import { describe, expect, it } from "vitest";
import {
  AUTO_LABEL_CHARS,
  BOOKMARK_EXCERPT_CHARS,
  anchoredText,
  bookmarkExcerpt,
  bookmarkLabel,
  cleanBookmarkLabel,
  compareBookmarks,
  compareBookmarksByMessage,
  sameAnchor,
  type AnchorMessage,
  type Bookmark,
} from "./bookmarks.js";

describe("bookmarkLabel", () => {
  it("uses the first heading", () => {
    expect(bookmarkLabel("Some intro.\n\n## Results for **Q3**\n\nmore")).toBe("Results for Q3");
  });
  it("else the first line, as plain text", () => {
    expect(bookmarkLabel("\n\n- Use `pnpm` and [the docs](https://x.y) *now*\n- two")).toBe("Use pnpm and the docs now");
  });
  it("skips code blocks, rules and table separators; table rows read as cells", () => {
    expect(bookmarkLabel("```ts\nconst a = 1;\n```\n---\n| Name | Size |\n|---|---|\n| a | 1 |")).toBe("Name Size");
  });
  it("falls back to the first code line for code-only messages", () => {
    expect(bookmarkLabel("```\nSELECT * FROM t;\n```")).toBe("SELECT * FROM t;");
  });
  it("cuts long lines at a word", () => {
    const label = bookmarkLabel("word ".repeat(40));
    expect(label.length).toBeLessThanOrEqual(AUTO_LABEL_CHARS);
    expect(label.endsWith("word…")).toBe(true);
  });
  it("never returns an empty label", () => {
    expect(bookmarkLabel("   ")).toBe("Message");
  });
});

describe("bookmarkExcerpt", () => {
  it("joins the prose into one plain paragraph without code", () => {
    expect(bookmarkExcerpt("# Title\n\nFirst **para**.\n\n```\ncode\n```\nSecond.")).toBe("Title First para. Second.");
  });
  it("is cut to the limit", () => {
    expect(bookmarkExcerpt("x ".repeat(500)).length).toBeLessThanOrEqual(BOOKMARK_EXCERPT_CHARS);
  });
});

describe("cleanBookmarkLabel", () => {
  it("trims, collapses spaces and treats blank as automatic", () => {
    expect(cleanBookmarkLabel("  Q3   numbers ")).toBe("Q3 numbers");
    expect(cleanBookmarkLabel("   ")).toBeNull();
    expect(cleanBookmarkLabel(null)).toBeNull();
  });
});

describe("anchoredText (anchor resolution)", () => {
  const msgs: AnchorMessage[] = [
    { role: "user", timestamp: 1, text: "what are the numbers?" },
    { role: "assistant", timestamp: 2, text: "Let me check." },
    { role: "assistant", timestamp: 3, text: null }, // tool call only
    { role: "side", timestamp: 4, text: null },
    { role: "assistant", timestamp: 5, text: "| a | 1 |" },
    { role: "user", timestamp: 6, text: "thanks" },
    { role: "assistant", timestamp: 7, text: "You're welcome." },
  ];

  it("a user message: its own text", () => {
    expect(anchoredText(msgs, { role: "user", timestamp: 6 })).toBe("thanks");
  });
  it("an agent reply: every text of its turn from the anchor on", () => {
    expect(anchoredText(msgs, { role: "assistant", timestamp: 2 })).toBe("Let me check.\n\n| a | 1 |");
    expect(anchoredText(msgs, { role: "assistant", timestamp: 7 })).toBe("You're welcome.");
  });
  it("matches by role + timestamp only, so changed ids (compaction, reloads) don't matter", () => {
    // After compaction the harness renumbers its messages and a notice is added; Glade's rows keep
    // their timestamps, so the bookmark still finds its reply (the notice ends the turn before it).
    const compacted: AnchorMessage[] = [{ role: "notice", timestamp: 100, text: null }, ...msgs.slice(5)];
    expect(anchoredText(compacted, { role: "assistant", timestamp: 7 })).toBe("You're welcome.");
  });
  it("returns null for a missing message (compacted away / not loaded) or the wrong role", () => {
    expect(anchoredText(msgs.slice(5), { role: "assistant", timestamp: 2 })).toBeNull();
    expect(anchoredText(msgs, { role: "user", timestamp: 2 })).toBeNull();
  });
  it("prefers the message with text on a timestamp tie", () => {
    const tie: AnchorMessage[] = [
      { role: "assistant", timestamp: 9, text: null },
      { role: "assistant", timestamp: 9, text: "answer" },
    ];
    expect(anchoredText(tie, { role: "assistant", timestamp: 9 })).toBe("answer");
  });
});

describe("ordering", () => {
  const b = (id: string, createdAt: number, ts: number): Bookmark => ({
    id,
    sessionId: "s",
    workspaceId: "w",
    message: { role: "assistant", timestamp: ts },
    label: id,
    labelSource: "auto",
    excerpt: "",
    createdAt,
  });
  it("newest first, or in transcript order", () => {
    const list = [b("a", 1, 30), b("b", 3, 10), b("c", 2, 20)];
    expect([...list].sort(compareBookmarks).map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect([...list].sort(compareBookmarksByMessage).map((x) => x.id)).toEqual(["b", "c", "a"]);
    const byTime = [b("x", 1, 50), b("y", 2, 5)];
    expect(byTime.sort(compareBookmarksByMessage).map((x) => x.id)).toEqual(["y", "x"]);
  });
  it("sameAnchor compares role and timestamp", () => {
    expect(sameAnchor({ role: "user", timestamp: 1 }, { role: "user", timestamp: 1 })).toBe(true);
    expect(sameAnchor({ role: "user", timestamp: 1 }, { role: "assistant", timestamp: 1 })).toBe(false);
  });
});
