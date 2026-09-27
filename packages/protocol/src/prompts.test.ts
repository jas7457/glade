import { describe, expect, it } from "vitest";
import { normalizePrompts, promptCommandName, promptsFor, type SavedPrompt } from "./prompts.js";

const p = (over: Partial<SavedPrompt>): SavedPrompt => ({ id: "x", name: "X", body: "b", projectId: null, ...over });

describe("saved prompts", () => {
  it("derives / menu names", () => {
    expect(promptCommandName("  Review Diff ")).toBe("review-diff");
    expect(promptCommandName("a / b  c")).toBe("a-b-c");
    expect(promptCommandName(" - ")).toBe("");
  });

  it("project prompts win over global ones with the same name", () => {
    const list = [p({ id: "g", name: "Tests" }), p({ id: "p", name: "tests", projectId: "P" }), p({ id: "o", name: "Other", projectId: "Q" })];
    expect(promptsFor(list, "P").map((x) => x.id)).toEqual(["p"]);
    expect(promptsFor(list, null).map((x) => x.id)).toEqual(["g"]);
    expect(promptsFor(undefined, null)).toEqual([]);
  });

  it("validates and trims", () => {
    expect(normalizePrompts([{ id: "a", name: " A ", description: "  ", body: " keep ", projectId: null, extra: 1 }])).toEqual([
      { id: "a", name: "A", body: " keep ", projectId: null },
    ]);
    expect(() => normalizePrompts([{ id: "a", name: "A", body: "b" }])).toThrow(/projectId/);
    expect(() => normalizePrompts([{ id: "a", name: "!", body: "b", projectId: null }])).not.toThrow();
    expect(() => normalizePrompts([{ id: "a", name: "-", body: "b", projectId: null }])).toThrow(/name/);
    expect(() => normalizePrompts({})).toThrow(/list/);
  });
});
