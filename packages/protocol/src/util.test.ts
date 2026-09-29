import { describe, expect, it } from "vitest";
import { deepMerge, quickTitle } from "./util.js";
import { defaultSettings } from "./api.js";
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
      models: { hiddenModels: ["a/b"] },
    });
    expect(merged.general.generateTitles).toBe(false);
    expect(merged.general.generateSummaries).toBe(true);
    expect(merged.models.hiddenModels).toEqual(["a/b"]);
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
