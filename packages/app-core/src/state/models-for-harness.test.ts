/** I-173: the host lists every offered agent's models; pickers show one agent's. */
import { describe, expect, it } from "vitest";
import { signal } from "@preact/signals";
import { defaultSettings, type ModelInfo } from "@glade/protocol";
import type { EnvShell } from "./env-registry";
import { modelsForHarness, visibleModelsOf } from "./store";

const model = (id: string, harness?: string): ModelInfo => ({ provider: "anthropic", id, name: id, thinkingLevels: ["off"], input: ["text"], ...(harness ? { harness } : {}) });

describe("modelsForHarness", () => {
  const all = [model("claude-opus", "pi"), model("gpt", "pi"), model("sonnet", "claude"), model("haiku", "claude")];

  it("picks one agent's models; without one, the first listed agent's (the host's default)", () => {
    expect(modelsForHarness(all, "claude").map((m) => m.id)).toEqual(["sonnet", "haiku"]);
    expect(modelsForHarness(all).map((m) => m.id)).toEqual(["claude-opus", "gpt"]);
    expect(modelsForHarness(all, "acp-mine")).toEqual([]);
  });

  it("keeps untagged models (older hosts) for every agent", () => {
    const old = [model("a"), model("b")];
    expect(modelsForHarness(old, "claude")).toEqual(old);
    expect(modelsForHarness(old)).toEqual(old);
  });

  it("hides the hidden ones", () => {
    const settings = defaultSettings();
    settings.models.hiddenModels = ["anthropic/haiku"];
    const shell = { settings: signal(settings), models: signal(all) } as unknown as EnvShell;
    expect(visibleModelsOf(shell, "claude").map((m) => m.id)).toEqual(["sonnet"]);
  });
});
