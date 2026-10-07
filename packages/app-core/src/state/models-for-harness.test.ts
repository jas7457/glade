/** I-173: the host lists every offered agent's models; pickers show one agent's. */
import { describe, expect, it } from "vitest";
import { signal } from "@preact/signals";
import { defaultSettings, type ModelInfo } from "@glade/protocol";
import type { EnvShell } from "./env-registry";
import { agentModelsOf, modelsForHarness, visibleModelsOf } from "./store";

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
    settings.models.agents = { claude: { hiddenModels: ["anthropic/haiku"] } };
    const shell = { settings: signal(settings), models: signal(all) } as unknown as EnvShell;
    expect(visibleModelsOf(shell, "claude").map((m) => m.id)).toEqual(["sonnet"]);
  });

  it("hides per agent: hiding pi's model doesn't hide Claude Code's with the same id (I-198)", () => {
    const same = [model("claude-opus", "pi"), model("claude-opus", "claude"), model("sonnet", "claude")];
    const settings = defaultSettings();
    settings.models.agents = { pi: { hiddenModels: ["anthropic/claude-opus"] } };
    const shell = { settings: signal(settings), models: signal(same), harnesses: signal(null) } as unknown as EnvShell;
    expect(visibleModelsOf(shell, "pi")).toEqual([]);
    expect(visibleModelsOf(shell).map((m) => m.id)).toEqual([]);
    expect(visibleModelsOf(shell, "claude").map((m) => m.id)).toEqual(["claude-opus", "sonnet"]);
  });

  it("reads an older host's global hidden list as its default agent's", () => {
    const old = { ...defaultSettings(), models: { hiddenModels: ["anthropic/sonnet"], defaultThinkingLevel: "high" } } as unknown as ReturnType<typeof defaultSettings>;
    const harnesses = signal([{ id: "claude", label: "Claude Code", isDefault: true, capabilities: {} }]);
    const shell = { settings: signal(old), models: signal(all), harnesses } as unknown as EnvShell;
    expect(visibleModelsOf(shell, "claude").map((m) => m.id)).toEqual(["haiku"]);
    expect(visibleModelsOf(shell, "pi").map((m) => m.id)).toEqual(["claude-opus", "gpt"]);
    expect(agentModelsOf(shell, "claude").defaultThinkingLevel).toBe("high");
    expect(agentModelsOf(shell, "pi").defaultThinkingLevel).toBe("medium");
  });
});
