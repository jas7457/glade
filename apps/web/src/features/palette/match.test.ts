import { describe, expect, it } from "vitest";
import { fuzzyMatch, rankItems } from "./match";

describe("fuzzyMatch", () => {
  it("matches prefixes, word starts, substrings and subsequences, in that order", () => {
    const prefix = fuzzyMatch("set", "Settings")!;
    const word = fuzzyMatch("set", "Open Settings")!;
    const sub = fuzzyMatch("ett", "Settings")!;
    const seq = fuzzyMatch("nwc", "New Chat")!;
    expect(prefix.score).toBeGreaterThan(word.score);
    expect(word.score).toBeGreaterThan(sub.score);
    expect(sub.score).toBeGreaterThan(seq.score);
    expect(prefix.indices).toEqual([0, 1, 2]);
    expect(word.indices).toEqual([5, 6, 7]);
    expect(seq.indices).toEqual([0, 2, 4]);
  });

  it("is case-insensitive, needs every word and rejects non-matches", () => {
    expect(fuzzyMatch("CHAT new", "New Chat")).not.toBeNull();
    expect(fuzzyMatch("new zebra", "New Chat")).toBeNull();
    expect(fuzzyMatch("xyz", "New Chat")).toBeNull();
    expect(fuzzyMatch("tahc", "New Chat")).toBeNull();
    // A subsequence has to start at a word.
    expect(fuzzyMatch("set", "Casual greeting")).toBeNull();
    expect(fuzzyMatch("sgt", "Casual greeting")).toBeNull();
  });

  it("prefers exact and shorter titles", () => {
    expect(fuzzyMatch("settings", "Settings")!.score).toBeGreaterThan(fuzzyMatch("settings", "Settings: Appearance")!.score);
  });

  it("matches everything with an empty query", () => {
    expect(fuzzyMatch("  ", "Anything")).toEqual({ score: 0, indices: [] });
  });
});

describe("rankItems", () => {
  const items = [
    { title: "Fix login bug", group: "Chats" },
    { title: "Refactor settings", group: "Chats" },
    { title: "pi-ui", group: "Projects" },
    { title: "New Chat", group: "Actions" },
    { title: "New Chat in pi-ui", group: "Actions", searchOnly: true },
    { title: "Settings", group: "Actions", keywords: ["preferences"] },
    { title: "Theme: Dark", group: "Actions", keywords: ["appearance"] },
  ];
  const opts = { groupOrder: ["Chats", "Projects", "Actions"], emptyLimit: { Chats: 1 } };
  const titles = (groups: ReturnType<typeof rankItems>) => groups.map((g) => [g.group, g.items.map((i) => i.item.title)]);

  it("keeps input order and group order for an empty query, hiding search-only items", () => {
    expect(titles(rankItems(items, "", opts))).toEqual([
      ["Chats", ["Fix login bug"]],
      ["Projects", ["pi-ui"]],
      ["Actions", ["New Chat", "Settings", "Theme: Dark"]],
    ]);
  });

  it("puts the group with the best match first and sorts by score", () => {
    const groups = rankItems(items, "settings", opts);
    expect(titles(groups)).toEqual([
      ["Actions", ["Settings"]],
      ["Chats", ["Refactor settings"]],
    ]);
  });

  it("includes search-only items and keyword matches when searching", () => {
    expect(titles(rankItems(items, "new chat pi", opts))).toEqual([["Actions", ["New Chat in pi-ui"]]]);
    const [group] = rankItems(items, "appearance", opts);
    expect(group!.items[0]!.item.title).toBe("Theme: Dark");
    expect(group!.items[0]!.indices).toEqual([]);
  });

  it("limits results per group", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `Chat ${i}`, group: "Chats" }));
    expect(rankItems(many, "chat", { limit: 5 })[0]!.items).toHaveLength(5);
  });
});
