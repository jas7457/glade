/**
 * I-207: model families from names (pi's Claude models, Codex's GPT models, Claude Code's aliases,
 * local GGUF names), newest-first order inside a family, and the filter.
 */
import { describe, expect, it } from "vitest";
import { compareVersions, groupByFamily, modelFamily, modelMatches, modelNameParts, type ModelLike } from "./model-families";

const m = (name: string, id = name.toLowerCase()): ModelLike => ({ id, name });
const grouped = (list: ModelLike[]) => groupByFamily(list).map((g) => [g.family, g.models.map((x) => x.name)]);

const PI_ANTHROPIC: ModelLike[] = [
  m("Claude Fable 5", "claude-fable-5"),
  m("Claude Fable 5.1", "claude-fable-5-1"),
  m("Claude Haiku 4.5 (latest)", "claude-haiku-4-5"),
  m("Claude Haiku 4.5", "claude-haiku-4-5-20251001"),
  m("Claude Haiku 5.5", "claude-haiku-5-5"),
  m("Claude Opus 4.5 (latest)", "claude-opus-4-5"),
  m("Claude Opus 4.5", "claude-opus-4-5-20251101"),
  m("Claude Opus 4.6", "claude-opus-4-6"),
  m("Claude Opus 4.7", "claude-opus-4-7"),
  m("Claude Opus 4.8", "claude-opus-4-8"),
  m("Claude Opus 5", "claude-opus-5"),
  m("Claude Opus 5.5", "claude-opus-5-5"),
  m("Claude Sonnet 4.5 (latest)", "claude-sonnet-4-5"),
  m("Claude Sonnet 4.5", "claude-sonnet-4-5-20250929"),
  m("Claude Sonnet 4.6", "claude-sonnet-4-6"),
  m("Claude Sonnet 5", "claude-sonnet-5"),
  m("Claude Sonnet 5.5", "claude-sonnet-5-5"),
];

const CODEX = ["GPT-5.5", "GPT-5.6-Luna", "GPT-5.6-Sol", "GPT-5.6-Terra", "GPT-6-Astra", "GPT-6-Luna", "GPT-6-Sol", "GPT-6.1-Sol"].map((n) => m(n));

const CLAUDE_CODE: ModelLike[] = [
  m("Opus 5.5", "opus"),
  m("Fable 5.1", "claude-fable-5-1[1m]"),
  m("Sonnet 5", "sonnet"),
  m("Haiku 4.5", "haiku"),
  m("Opus 4.8", "claude-opus-4-8"),
];

describe("modelFamily", () => {
  it("pi's Claude models: version, date and (latest) dropped", () => {
    expect(PI_ANTHROPIC.map(modelFamily)).toEqual([
      "Claude Fable",
      "Claude Fable",
      "Claude Haiku",
      "Claude Haiku",
      "Claude Haiku",
      ...Array(7).fill("Claude Opus"),
      ...Array(5).fill("Claude Sonnet"),
    ]);
  });

  it("Codex's GPT models: the version goes, the variant stays", () => {
    expect(CODEX.map(modelFamily)).toEqual(["GPT", "GPT Luna", "GPT Sol", "GPT Terra", "GPT Astra", "GPT Luna", "GPT Sol", "GPT Sol"]);
  });

  it("Claude Code's models", () => {
    expect(CLAUDE_CODE.map(modelFamily)).toEqual(["Opus", "Fable", "Sonnet", "Haiku", "Opus"]);
  });

  it("local models: leading name without version, size, quantization or qualifiers", () => {
    expect(modelFamily(m("Qwen3.8-27B-Q4_K_M"))).toBe("Qwen");
    expect(modelFamily(m("Meta-Llama-3.1-8B-Instruct-Q4_K_M"))).toBe("Meta Llama");
    expect(modelFamily(m("Mistral-7B-Instruct-v0.3.Q8_0.gguf"))).toBe("Mistral");
    expect(modelFamily(m("unsloth/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL"))).toBe("Qwen Coder");
    expect(modelFamily(m("gemma-3-27b-it-qat-q4_0"))).toBe("gemma");
    expect(modelFamily(m("Gemma 4 26B A4B IT"))).toBe("Gemma");
    expect(modelFamily(m("Mixtral 8x7B"))).toBe("Mixtral");
    expect(modelFamily(m("DeepSeek-R1-Distill-Qwen-32B-Q5_K_M"))).toBe("DeepSeek R1 Distill Qwen");
  });

  it("other providers' names", () => {
    expect(modelFamily(m("Gemini 3.1 Pro Preview"))).toBe("Gemini Pro");
    expect(modelFamily(m("Gemini Flash Latest"))).toBe("Gemini Flash");
    expect(modelFamily(m("Gemini 2.5 Flash-Lite"))).toBe("Gemini Flash Lite");
    expect(modelFamily(m("GPT-4o (2024-05-13)"))).toBe("GPT");
    expect(modelFamily(m("GPT-4.1 mini"))).toBe("GPT mini");
    expect(modelFamily(m("Devstral Small 2505"))).toBe("Devstral Small");
    expect(modelFamily(m("Mistral Large (latest)"))).toBe("Mistral Large");
    expect(modelFamily(m("Claude Opus 4.5 (EU)"))).toBe("Claude Opus");
    expect(modelFamily(m("Claude 3 Opus", "claude-3-opus-20240229"))).toBe("Claude Opus");
  });

  it("a name with nothing to strip is its own family; short letter+digit names stay whole", () => {
    expect(modelFamily(m("Daybreak Blue"))).toBe("Daybreak Blue");
    expect(modelFamily(m("o3"))).toBe("o3");
    expect(modelFamily(m("o3-mini"))).toBe("o3 mini");
    expect(modelFamily(m("Kimi K2"))).toBe("Kimi K2");
  });

  it("falls back to the id when the name is bare or only a version", () => {
    expect(modelFamily({ id: "claude-opus-4-5-20251101", name: "4.5" })).toBe("claude opus");
    expect(modelFamily({ id: "x", name: "" })).toBe("x");
    expect(modelFamily({ id: "12345", name: "12345" })).toBe("12345");
    // The version comes from the id when the name has none.
    expect(modelNameParts({ id: "claude-opus-4-8", name: "Opus" }).version).toEqual([4, 8]);
  });
});

describe("modelNameParts", () => {
  it("parses versions, dates and aliases from names and ids", () => {
    expect(modelNameParts(m("Claude Opus 4.5", "claude-opus-4-5-20251101"))).toEqual({ family: "Claude Opus", version: [4, 5], date: 20251101, latest: false, size: null });
    expect(modelNameParts(m("Claude Opus 4.5 (latest)", "claude-opus-4-5"))).toMatchObject({ version: [4, 5], date: null, latest: true });
    expect(modelNameParts(m("GPT-6.1-Sol"))).toMatchObject({ version: [6, 1] });
    expect(modelNameParts(m("Qwen3.8-27B-Q4_K_M"))).toMatchObject({ version: [3, 8], size: 27 });
    expect(modelNameParts(m("GPT-4o (2024-05-13)"))).toMatchObject({ version: [4], date: 20240513 });
    expect(modelNameParts(m("Gemini 2.5 Computer Use Preview 10-2025"))).toMatchObject({ family: "Gemini Computer Use", version: [2, 5], date: 2025 });
  });

  it("compares versions part by part", () => {
    expect(compareVersions([5], [5, 0])).toBe(0);
    expect(compareVersions([4, 8], [5])).toBeLessThan(0);
    expect(compareVersions([6, 1], [6])).toBeGreaterThan(0);
  });
});

describe("groupByFamily", () => {
  it("pi's Claude models: families A–Z, newest first, the (latest) alias next to its version", () => {
    expect(grouped(PI_ANTHROPIC)).toEqual([
      ["Claude Fable", ["Claude Fable 5.1", "Claude Fable 5"]],
      ["Claude Haiku", ["Claude Haiku 5.5", "Claude Haiku 4.5 (latest)", "Claude Haiku 4.5"]],
      [
        "Claude Opus",
        ["Claude Opus 5.5", "Claude Opus 5", "Claude Opus 4.8", "Claude Opus 4.7", "Claude Opus 4.6", "Claude Opus 4.5 (latest)", "Claude Opus 4.5"],
      ],
      ["Claude Sonnet", ["Claude Sonnet 5.5", "Claude Sonnet 5", "Claude Sonnet 4.6", "Claude Sonnet 4.5 (latest)", "Claude Sonnet 4.5"]],
    ]);
  });

  it("Codex and Claude Code", () => {
    expect(grouped(CODEX)).toEqual([
      ["GPT", ["GPT-5.5"]],
      ["GPT Astra", ["GPT-6-Astra"]],
      ["GPT Luna", ["GPT-6-Luna", "GPT-5.6-Luna"]],
      ["GPT Sol", ["GPT-6.1-Sol", "GPT-6-Sol", "GPT-5.6-Sol"]],
      ["GPT Terra", ["GPT-5.6-Terra"]],
    ]);
    expect(grouped(CLAUDE_CODE)).toEqual([
      ["Fable", ["Fable 5.1"]],
      ["Haiku", ["Haiku 4.5"]],
      ["Opus", ["Opus 5.5", "Opus 4.8"]],
      ["Sonnet", ["Sonnet 5"]],
    ]);
  });

  it("a versionless latest alias first, unversioned models last; families match case-insensitively", () => {
    expect(grouped([m("Mistral Large 3"), m("Mistral Large (latest)", "mistral-large-latest"), m("Mistral Large 2.1")])).toEqual([
      ["Mistral Large", ["Mistral Large (latest)", "Mistral Large 3", "Mistral Large 2.1"]],
    ]);
    expect(grouped([m("GPT-4.1 mini"), m("GPT-5 Mini")])).toEqual([["GPT Mini", ["GPT-5 Mini", "GPT-4.1 mini"]]]);
    expect(grouped([m("Qwen3.8-8B"), m("Qwen3.8-27B"), m("Qwen")])).toEqual([["Qwen", ["Qwen3.8-27B", "Qwen3.8-8B", "Qwen"]]]);
    expect(grouped([])).toEqual([]);
  });
});

describe("modelMatches", () => {
  it("matches name or id, case-insensitive, every word", () => {
    const opus = m("Claude Opus 4.5", "claude-opus-4-5-20251101");
    expect(modelMatches(opus, "")).toBe(true);
    expect(modelMatches(opus, "  ")).toBe(true);
    expect(modelMatches(opus, "OPUS")).toBe(true);
    expect(modelMatches(opus, "20251101")).toBe(true);
    expect(modelMatches(opus, "opus 4.5")).toBe(true);
    expect(modelMatches(opus, "opus 4-5")).toBe(true); // id
    expect(modelMatches(opus, "sonnet")).toBe(false);
    expect(modelMatches(opus, "opus 5")).toBe(true); // "5" is in "4.5"
    expect(modelMatches(opus, "opus haiku")).toBe(false);
  });
});
