import { describe, expect, it } from "vitest";
import { deepMerge, quickTitle } from "./util.js";
import { DEFAULT_AGENT_MODEL_SETTINGS, agentModelSettings, defaultSettings, quickTasksModel, type Settings } from "./api.js";
import { clampThinkingLevel, parseModelKey } from "./models.js";

describe("quickTitle", () => {
  it("uses the first meaningful line without markdown", () => {
    expect(quickTitle("\n\n## Fix the **login** bug\nmore")).toBe("Fix the login bug");
  });
  it("skips code fences", () => {
    expect(quickTitle("```ts\nconst a = 1\n```")).toBe("const a = 1");
  });
  it("truncates at a word boundary", () => {
    const title = quickTitle("Please refactor the authentication module so that it uses the new session store", 40);
    expect(title.length).toBeLessThanOrEqual(41);
    expect(title.endsWith("…")).toBe(true);
    expect(title).toBe("Please refactor the authentication…");
  });
  it("falls back for empty input", () => {
    expect(quickTitle("   ")).toBe("New chat");
  });
});

describe("deepMerge", () => {
  it("merges nested sections and replaces arrays", () => {
    const merged = deepMerge(defaultSettings(), {
      general: { generateTitles: false },
      models: { agents: { pi: { hiddenModels: ["a/b"] } } },
    });
    expect(merged.general.generateTitles).toBe(false);
    expect(merged.general.generateSummaries).toBe(true);
    expect(merged.models.agents.pi?.hiddenModels).toEqual(["a/b"]);
  });
});

describe("agentModelSettings (I-198)", () => {
  it("fills defaults for an agent without settings", () => {
    const s = defaultSettings();
    expect(agentModelSettings(s, "claude")).toEqual({ ...DEFAULT_AGENT_MODEL_SETTINGS, hiddenModels: [] });
  });
  it("reads the agent's own entry", () => {
    const s = deepMerge(defaultSettings(), { models: { agents: { codex: { defaultThinkingLevel: "high", hiddenModels: ["x/y"] } } } });
    expect(agentModelSettings(s, "codex").defaultThinkingLevel).toBe("high");
    expect(agentModelSettings(s, "codex").hiddenModels).toEqual(["x/y"]);
    expect(agentModelSettings(s, "pi").hiddenModels).toEqual([]);
  });
  it("reads an older server's global fields as the default agent's", () => {
    const old = { models: { defaultModel: { provider: "a", id: "m" }, hiddenModels: ["a/old"], smallModel: { provider: "a", id: "s" } } } as unknown as Settings;
    expect(agentModelSettings(old, "pi", "pi").defaultModel).toEqual({ provider: "a", id: "m" });
    expect(agentModelSettings(old, "pi", "pi").hiddenModels).toEqual(["a/old"]);
    expect(agentModelSettings(old, "claude", "pi").hiddenModels).toEqual([]);
    expect(quickTasksModel(old, "pi")).toEqual({ harness: "pi", model: { provider: "a", id: "s" } });
    expect(quickTasksModel(defaultSettings(), "pi")).toBeNull();
  });
});

describe("models", () => {
  it("parses model keys with slashes in the id", () => {
    expect(parseModelKey("openrouter/meta/llama")).toEqual({ provider: "openrouter", id: "meta/llama" });
    expect(parseModelKey("nope")).toBeNull();
  });
  it("clamps thinking levels upward first", () => {
    expect(clampThinkingLevel(["off", "low", "high"], "medium")).toBe("high");
    expect(clampThinkingLevel(["off", "low"], "max")).toBe("low");
    expect(clampThinkingLevel(["off"], "high")).toBe("off");
  });
});
