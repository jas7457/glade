import { describe, expect, it } from "vitest";
import type { ModelInfo, SlashCommand } from "@glade/protocol";
import { builtinCommands, matchModel } from "./builtins";
import { filterCommands, mergeCommands, parseSlash } from "./match";

const COMMANDS: SlashCommand[] = [
  { name: "compact", source: "builtin", description: "Summarize the conversation to free up context" },
  { name: "model", source: "builtin", description: "Switch model" },
  { name: "mcp", source: "extension", description: "Manage MCP servers" },
  { name: "websearch", source: "extension", description: "Search the web" },
  { name: "skill:web-design", source: "skill", description: "Design websites" },
  { name: "fix-tests", source: "prompt", description: "Fix failing tests" },
];

const names = (groups: ReturnType<typeof filterCommands>) => groups.flatMap((g) => g.commands.map((c) => c.name));

describe("parseSlash", () => {
  it("parses a command at the start of the text", () => {
    expect(parseSlash("/")).toEqual({ name: "", args: "", hasArgs: false });
    expect(parseSlash("/comp")).toEqual({ name: "comp", args: "", hasArgs: false });
    expect(parseSlash("/compact keep the API notes ")).toEqual({ name: "compact", args: "keep the API notes", hasArgs: true });
    expect(parseSlash("/name ")).toEqual({ name: "name", args: "", hasArgs: true });
    expect(parseSlash("/skill:web-design\nbuild a page")).toMatchObject({ name: "skill:web-design", args: "build a page" });
  });
  it("ignores text that isn't a command", () => {
    expect(parseSlash("hello /compact")).toBeNull();
    expect(parseSlash(" /compact")).toBeNull();
    expect(parseSlash("//comment")).toBeNull();
    expect(parseSlash("")).toBeNull();
  });
});

describe("filterCommands", () => {
  it("lists everything grouped Built-in / Extensions / Skills / Prompts for an empty query", () => {
    const groups = filterCommands([...COMMANDS].reverse(), "");
    expect(groups.map((g) => g.label)).toEqual(["Built-in", "Extensions", "Skills", "Prompts"]);
  });
  it("matches name prefixes, substrings, skill names without the prefix, descriptions and fuzzy", () => {
    expect(names(filterCommands(COMMANDS, "comp"))).toEqual(["compact"]);
    expect(names(filterCommands(COMMANDS, "web"))).toEqual(["websearch", "skill:web-design"]);
    expect(names(filterCommands(COMMANDS, "failing"))).toEqual(["fix-tests"]);
    expect(names(filterCommands(COMMANDS, "wsrch"))).toEqual(["websearch"]);
    expect(names(filterCommands(COMMANDS, "zzz"))).toEqual([]);
    // Fuzzy is a fallback only: "mc" is a subsequence of "compact" but "mcp" is a real match.
    expect(names(filterCommands(COMMANDS, "mc"))).toEqual(["mcp"]);
  });
  it("puts the group with the best match first", () => {
    const groups = filterCommands(COMMANDS, "fix");
    expect(groups[0]!.label).toBe("Prompts");
    expect(filterCommands([...COMMANDS, { name: "fixup", source: "builtin" }], "fix-tests")[0]!.label).toBe("Prompts");
  });
  it("ranks better matches first within a group", () => {
    const list: SlashCommand[] = [
      { name: "team", source: "extension", description: "uses mcp" },
      { name: "mcp", source: "extension" },
    ];
    expect(names(filterCommands(list, "mcp"))).toEqual(["mcp", "team"]);
  });
  it("sorts each group alphabetically (case-insensitive, ignoring skill:) for an empty query", () => {
    const list: SlashCommand[] = [
      { name: "settings", source: "builtin" },
      { name: "compact", source: "builtin" },
      { name: "reply", source: "extension" },
      { name: "Queue", source: "extension" },
      { name: "cd", source: "extension" },
      { name: "skill:zebra", source: "skill" },
      { name: "skill:alpha", source: "skill" },
    ];
    expect(filterCommands(list, "").map((g) => g.commands.map((c) => c.name))).toEqual([
      ["compact", "settings"],
      ["cd", "Queue", "reply"],
      ["skill:alpha", "skill:zebra"],
    ]);
  });
  it("keeps match quality first and breaks ties alphabetically", () => {
    const list: SlashCommand[] = [
      { name: "prompt-web", source: "extension" },
      { name: "webz", source: "extension" },
      { name: "weba", source: "extension" },
      { name: "web", source: "extension" },
    ];
    expect(names(filterCommands(list, "web"))).toEqual(["web", "weba", "webz", "prompt-web"]);
  });
});

describe("mergeCommands / builtinCommands", () => {
  it("puts built-ins first and drops harness commands that clash", () => {
    const merged = mergeCommands(builtinCommands(true), [{ name: "compact", source: "extension" }, { name: "mcp", source: "extension" }]);
    expect(merged.filter((c) => c.name === "compact")).toHaveLength(1);
    expect(merged.at(-1)!.name).toBe("mcp");
  });
  it("offers only chat-independent built-ins before a chat exists", () => {
    expect(builtinCommands(false).map((c) => c.name)).toEqual(["model", "thinking", "settings"]);
    expect(builtinCommands(true).map((c) => c.name)).toEqual(["compact", "btw", "new", "name", "model", "thinking", "export", "stats", "settings"]);
  });
});

describe("matchModel", () => {
  const models: ModelInfo[] = [
    { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5", thinkingLevels: ["off"], input: ["text"] },
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", thinkingLevels: ["off"], input: ["text"] },
    { provider: "openai", id: "gpt-5", name: "GPT-5", thinkingLevels: ["off"], input: ["text"] },
  ];
  it("finds a unique exact or partial match", () => {
    expect(matchModel(models, "haiku").match?.id).toBe("claude-haiku-4-5");
    expect(matchModel(models, "openai/gpt-5").match?.id).toBe("gpt-5");
    expect(matchModel(models, "GPT-5").match?.id).toBe("gpt-5");
  });
  it("returns candidates when ambiguous or empty", () => {
    expect(matchModel(models, "claude")).toMatchObject({ match: null });
    expect(matchModel(models, "claude").candidates).toHaveLength(2);
    expect(matchModel(models, "nope").candidates).toHaveLength(0);
  });
});
