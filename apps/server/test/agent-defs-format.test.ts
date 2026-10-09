/**
 * I-218: the small YAML and TOML readers and Glade's agent file format (parse ↔ serialize).
 */
import { describe, expect, it } from "vitest";
import { emptyAgentDefFields, type AgentDefFields } from "@glade/protocol";
import { parseGladeAgent, serializeGladeAgent } from "../src/services/agent-defs/format.js";
import { gladeModel, readList, splitFrontmatter } from "../src/services/agent-defs/fields.js";
import { parseToml } from "../src/services/agent-defs/toml-lite.js";
import { parseYaml, splitTopLevel, yamlString } from "../src/services/agent-defs/yaml-lite.js";

describe("yaml-lite", () => {
  it("reads scalars, quoted strings and comments", () => {
    expect(
      parseYaml(
        [
          "name: scout # the agent",
          "count: 3",
          "ratio: 0.5",
          "on: true",
          "off: false",
          "none: ~",
          "empty:",
          `double: "a: b # not a comment\\n\\u00e9"`,
          "single: 'it''s'",
          "url: see http://x.y/z",
          "text: It's fine: really",
        ].join("\n"),
      ),
    ).toEqual({ name: "scout", count: 3, ratio: 0.5, on: true, off: false, none: null, empty: null, double: "a: b # not a comment\né", single: "it's", url: "see http://x.y/z", text: "It's fine: really" });
  });

  it("reads flow and block lists, nested maps and lists of maps", () => {
    const doc = parseYaml(
      [
        "tools: [Read, 'Grep', \"Bash(git:*)\"]",
        "nickname:",
        "  - Brandon",
        "  - Bea",
        "skills:",
        "- one",
        "- two",
        "mcpServers:",
        "  github:",
        "    command: npx",
        "    args: [-y, server]",
        "hooks:",
        "  PreToolUse:",
        "    - matcher: Bash",
        "      hooks:",
        "        - type: command",
        "          command: ./check.sh",
        "flow: {a: 1, b: [x, y]}",
        "multi: [a,",
        "  b]",
      ].join("\n"),
    );
    expect(doc).toEqual({
      tools: ["Read", "Grep", "Bash(git:*)"],
      nickname: ["Brandon", "Bea"],
      skills: ["one", "two"],
      mcpServers: { github: { command: "npx", args: ["-y", "server"] } },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh" }] }] },
      flow: { a: 1, b: ["x", "y"] },
      multi: ["a", "b"],
    });
  });

  it("reads block scalars with chomping and folded plain scalars", () => {
    const doc = parseYaml(["lit: |", "  line 1", "    indented", "", "  line 3", "", "strip: |-", "  x", "fold: >", "  a", "  b", "", "  c", "plain: one", "  two", "last: z"].join("\n"));
    expect(doc).toEqual({ lit: "line 1\n  indented\n\nline 3\n", strip: "x", fold: "a b\nc\n", plain: "one two", last: "z" });
  });

  it("refuses broken documents", () => {
    expect(() => parseYaml("a: [1, 2")).toThrow();
    expect(() => parseYaml("a: 1\n   b: 2")).toThrow();
    expect(() => parseYaml("just text")).toThrow();
  });

  it("splits top-level keys with their raw text", () => {
    expect(splitTopLevel("a: 1\nhooks:\n  x: 1\n\n  y: 2\nb: 2")).toEqual([
      { key: "a", raw: "a: 1" },
      { key: "hooks", raw: "hooks:\n  x: 1\n\n  y: 2" },
      { key: "b", raw: "b: 2" },
    ]);
  });

  it("quotes only when needed", () => {
    expect(yamlString("Brandon")).toBe("Brandon");
    expect(yamlString("Read, Grep")).toBe("Read, Grep");
    expect(yamlString("Use when: x")).toBe('"Use when: x"');
    expect(yamlString("true")).toBe('"true"');
    expect(yamlString("42")).toBe('"42"');
    expect(yamlString("- x")).toBe('"- x"');
    expect(yamlString("a\nb")).toBe('"a\\nb"');
    for (const s of ["Use when: x", "true", "a\nb", "  pad", "#hash", "it's", 'say "hi"', "x # y"]) {
      expect(parseYaml(`k: ${yamlString(s)}`).k).toBe(s);
    }
  });
});

describe("toml-lite", () => {
  it("reads a Codex agent file", () => {
    const doc = parseToml(
      [
        "# reviewer",
        'name = "reviewer"',
        "description = 'Reviews code'",
        'developer_instructions = """',
        'Be strict.\\tCite "file:line".',
        '"""',
        'model = "gpt-6"',
        'model_reasoning_effort = "high"',
        'sandbox_mode = "read-only"',
        'nickname_candidates = ["Rex", "Ria",',
        "  ]",
        "max = 1_000",
        "ratio = 0.25",
        "on = true",
        "",
        "[mcp_servers.docs]",
        'command = "docs-mcp"',
        'args = ["--x"]',
        "env = { A = '1', B.c = 2 }",
        "",
        "[[profiles]]",
        'name = "a"',
        "[[profiles]]",
        'name = "b"',
      ].join("\n"),
    );
    expect(doc).toEqual({
      name: "reviewer",
      description: "Reviews code",
      developer_instructions: 'Be strict.\tCite "file:line".\n',
      model: "gpt-6",
      model_reasoning_effort: "high",
      sandbox_mode: "read-only",
      nickname_candidates: ["Rex", "Ria"],
      max: 1000,
      ratio: 0.25,
      on: true,
      mcp_servers: { docs: { command: "docs-mcp", args: ["--x"], env: { A: "1", B: { c: 2 } } } },
      profiles: [{ name: "a" }, { name: "b" }],
    });
  });

  it("reads literal multi-line strings, line-ending backslashes and dotted keys", () => {
    expect(parseToml("a = '''\nraw \\n text'''\nb = \"\"\"one \\\n   two\"\"\"\nx.y.z = 1\n\"quoted key\" = 2")).toEqual({
      a: "raw \\n text",
      b: "one two",
      x: { y: { z: 1 } },
      "quoted key": 2,
    });
  });

  it("refuses broken files with a line number", () => {
    expect(() => parseToml('a = "x')).toThrow(/line 1/);
    expect(() => parseToml("a = 1\na = 2")).toThrow(/twice/);
    expect(() => parseToml("a = 1\n[t]\nb =")).toThrow(/line 3/);
  });
});

describe("fields", () => {
  it("splits frontmatter and reads lists", () => {
    expect(splitFrontmatter("---\nname: x\n---\nbody\n")).toEqual({ frontmatter: "name: x", body: "body\n" });
    expect(splitFrontmatter("---\n---\nbody")).toEqual({ frontmatter: "", body: "body" });
    expect(splitFrontmatter("no frontmatter")).toEqual({ frontmatter: null, body: "no frontmatter" });
    expect(readList("Read, Grep , ,Glob")).toEqual(["Read", "Grep", "Glob"]);
    expect(readList(["a", "a", " b "])).toEqual(["a", "b"]);
    expect(readList([])).toEqual([]);
    expect(readList(undefined)).toBeNull();
  });

  it("translates models to Glade's values per harness", () => {
    expect(gladeModel("claude", "haiku")).toBe("anthropic/haiku");
    expect(gladeModel("claude", "claude-sonnet-4-5")).toBe("anthropic/claude-sonnet-4-5");
    expect(gladeModel("claude", "inherit")).toBe("inherit");
    expect(gladeModel("codex", "gpt-6")).toBe("codex/gpt-6");
    expect(gladeModel("pi", "anthropic/claude-haiku-4-5")).toBe("anthropic/claude-haiku-4-5");
    expect(gladeModel("pi", null)).toBe("inherit");
  });
});

describe("Glade agent format", () => {
  const full: AgentDefFields = {
    name: "scout",
    description: "Use when: finding code. Not for edits.",
    harness: "claude",
    model: "anthropic/haiku",
    thinking: "off",
    extends: null,
    nicknames: ["Brandon", "Bea"],
    color: "teal",
    icon: "search",
    tools: ["Read", "Grep", "Glob"],
    disallowedTools: ["Bash(rm:*)"],
    permissionMode: "plan",
    sandbox: null,
    prompt: "Trace the real code path.\n\n- cite file:line",
  };

  it("writes deterministically and reads back the same fields", () => {
    const text = serializeGladeAgent(full);
    expect(text).toBe(
      [
        "---",
        "name: scout",
        'description: "Use when: finding code. Not for edits."',
        "harness: claude",
        "model: anthropic/haiku",
        "thinking: off",
        "nickname: [Brandon, Bea]",
        "color: teal",
        "icon: search",
        "tools: Read, Grep, Glob",
        "disallowedTools: Bash(rm:*)",
        "permissionMode: plan",
        "---",
        "Trace the real code path.",
        "",
        "- cite file:line",
        "",
      ].join("\n"),
    );
    const parsed = parseGladeAgent(text, "file");
    expect(parsed.fields).toEqual(full);
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("leaves inherit, null and empty values out", () => {
    const fields = { ...emptyAgentDefFields(), name: "bare" };
    expect(serializeGladeAgent(fields)).toBe("---\nname: bare\n---\n");
    expect(parseGladeAgent(serializeGladeAgent(fields), "x").fields).toEqual(fields);
    // An explicit empty tool list is kept (no tools at all).
    const none = { ...fields, tools: [] };
    expect(parseGladeAgent(serializeGladeAgent(none), "x").fields.tools).toEqual([]);
  });

  it("keeps unknown keys as written", () => {
    const text = "---\nname: x\nmcpServers:\n  github:\n    command: npx # keep me\nharness: claude\nmaxTurns: 5\n---\nbody";
    const parsed = parseGladeAgent(text, "x");
    expect(parsed.unknown).toEqual({ mcpServers: { github: { command: "npx" } }, maxTurns: 5 });
    const again = serializeGladeAgent({ ...parsed.fields, prompt: "new body" }, parsed.unknownRaw);
    expect(again).toBe("---\nname: x\nharness: claude\nmcpServers:\n  github:\n    command: npx # keep me\nmaxTurns: 5\n---\nnew body\n");
  });

  it("is lenient when reading: single nickname, list tools, bad values become warnings", () => {
    const parsed = parseGladeAgent("---\nnickname: Brandon\ntools:\n  - read\n  - bash\nthinking: turbo\ncolor: red\nicon: rocket\nsandbox: nope\n---\n\n  hi  \n", "My Agent");
    expect(parsed.fields).toMatchObject({ name: "my-agent", nicknames: ["Brandon"], tools: ["read", "bash"], thinking: "inherit", color: null, icon: "rocket", sandbox: null, prompt: "hi" });
    expect(parsed.warnings).toEqual(['unknown thinking level "turbo"', 'unknown color "red"', 'unknown sandbox mode "nope"']);
    expect(parseGladeAgent("---\nname: [oops\n---\n", "broken").errors[0]).toMatch(/can't read the frontmatter/);
  });
});
