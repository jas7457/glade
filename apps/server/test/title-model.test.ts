/**
 * I-023: generated titles default to Haiku when it's available.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelInfo, ModelRef } from "@pi-ui/protocol";
import { FAKE_MODELS } from "../src/harness/fake/fake-harness.js";
import type { GenerateTitleOptions } from "../src/harness/types.js";
import { createTestEnv, until, type TestEnv } from "./helpers.js";

const HAIKU: ModelInfo = {
  provider: "anthropic",
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  thinkingLevels: ["off"],
  input: ["text"],
  contextWindow: 200_000,
};

let env: TestEnv;
let titleCalls: GenerateTitleOptions[];
beforeEach(() => {
  env = createTestEnv();
  titleCalls = [];
  env.harness.generateTitle = async (options) => {
    titleCalls.push(options);
    return "Generated";
  };
});
afterEach(async () => {
  await env.cleanup();
});

async function titleModelFor(chatModel: ModelRef = { provider: "fake", id: "smart" }): Promise<ModelRef | null> {
  await env.service.createWorkspace({ projectId: null, prompt: "hello", model: chatModel });
  await until(() => titleCalls.length === 1);
  return titleCalls[0]!.model;
}

describe("title model", () => {
  it("uses Haiku when it's available and no title model is set", async () => {
    env.harness.listModels = async () => [...FAKE_MODELS, HAIKU];
    expect(await titleModelFor()).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  });

  it("falls back to the chat's model when Haiku isn't available", async () => {
    expect(await titleModelFor({ provider: "fake", id: "fast" })).toEqual({ provider: "fake", id: "fast" });
  });

  it("an explicit title model wins", async () => {
    env.harness.listModels = async () => [...FAKE_MODELS, HAIKU];
    env.service.updateSettings({ models: { titleModel: { provider: "fake", id: "fast" } } });
    expect(await titleModelFor()).toEqual({ provider: "fake", id: "fast" });
  });

  it("falls back when listing models fails", async () => {
    env.harness.listModels = async () => {
      throw new Error("offline");
    };
    expect(await titleModelFor()).toEqual({ provider: "fake", id: "smart" });
  });
});
