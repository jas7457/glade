/**
 * I-078: the sub-agent model/thinking settings. Precedence: the spawn request (or agent
 * definition) → `settings.models.subagentModel`/`subagentThinkingLevel` → the parent's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestEnv, flush, newChat, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
  env.service.setServerUrl("http://127.0.0.1:4999");
  env.harness.script = () => [];
});
afterEach(async () => {
  await env.cleanup();
});

async function spawnFrom(extra: Record<string, unknown> = {}) {
  const chat = await newChat(env, { prompt: "orchestrate", model: { provider: "fake", id: "smart" }, thinkingLevel: "high" });
  await flush();
  const { agent } = await env.service.spawnAgent(chat.sid, { name: "helper", task: "do it", ...extra });
  return env.store.getSession(agent.sessionId)!;
}

describe("sub-agent model and thinking (I-078)", () => {
  it("inherits the parent's model and thinking when the settings are unset", async () => {
    expect(await spawnFrom()).toMatchObject({ model: { provider: "fake", id: "smart" }, thinkingLevel: "high" });
  });

  it("uses the settings over the parent's", async () => {
    env.service.updateSettings({ models: { subagentModel: { provider: "fake", id: "fast" }, subagentThinkingLevel: "low" } });
    expect(await spawnFrom()).toMatchObject({ model: { provider: "fake", id: "fast" }, thinkingLevel: "low" });
  });

  it("an explicit model/thinking in the request wins over the settings", async () => {
    env.service.updateSettings({ models: { subagentModel: { provider: "fake", id: "fast" }, subagentThinkingLevel: "low" } });
    expect(await spawnFrom({ model: "smart", thinking: "medium" })).toMatchObject({
      model: { provider: "fake", id: "smart" },
      thinkingLevel: "medium",
    });
  });

  it("each setting applies on its own", async () => {
    env.service.updateSettings({ models: { subagentThinkingLevel: "off" } });
    expect(await spawnFrom()).toMatchObject({ model: { provider: "fake", id: "smart" }, thinkingLevel: "off" });
  });

  it("falls back to the parent's model when the setting's model isn't in the parent's harness", async () => {
    env.service.updateSettings({ models: { subagentModel: { provider: "elsewhere", id: "tiny" } } });
    expect((await spawnFrom()).model).toEqual({ provider: "fake", id: "smart" });
  });
});
