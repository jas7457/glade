/**
 * Settings → Agents (I-155, I-159, I-173, I-198): pi and Claude Code with found/not found and
 * Enable; no install advice; each agent's own page with only its models; the quick-tasks model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { MemoryRouter, Route, Routes } from "react-router";
import { defaultSettings, type AgentCatalogEntry, type HarnessCapabilities, type HarnessInfo, type ModelInfo } from "@glade/protocol";

const CATALOG: AgentCatalogEntry[] = [
  { id: "pi", label: "pi", kind: "builtin", command: "pi", lookedFor: ["pi"], installed: true, enabled: true, offered: true, isDefault: true },
  {
    id: "claude",
    label: "Claude Code",
    kind: "builtin",
    command: "claude",
    lookedFor: ["claude"],
    installed: false,
    enabled: true,
    offered: false,
    isDefault: false,
  },
];
let catalog = CATALOG;

vi.mock("@glade/app-core/lib/api", () => ({
  api: { updateSettings: vi.fn(), listModels: vi.fn() },
  request: vi.fn(async (_method: string, path: string) => (path === "/agent-catalog" ? catalog : [])),
}));

import { api, request } from "@glade/app-core/lib/api";
import { ConfirmHost, TooltipProvider } from "@glade/app-core/ui";
import { models, settings } from "@glade/app-core/state/store";
import { harnesses } from "@glade/app-core/state/harnesses";
import { agentCatalogs } from "@glade/app-core/state/agent-catalog";
import { SettingsAgentRoute, SettingsRoute } from "./SettingsView";
import { groupModelsByAgent } from "./ModelSettings";
import { fallbackCatalog } from "./AgentSettings";

const mocked = vi.mocked(api);
const CAPS: HarnessCapabilities = { compact: true, exportHtml: true, steering: true, uiRequests: true, usageLimits: true, commands: true, subagents: true, shell: true };
const PI: HarnessInfo = { id: "pi", label: "pi", isDefault: true, capabilities: CAPS };
const MINE: HarnessInfo = { id: "acp-mine", label: "Mine", isDefault: false, capabilities: { ...CAPS, models: false } };

function renderAt(section: string) {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[`/settings/${section}`]}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsRoute />} />
          <Route path="/settings/agent/:harness" element={<SettingsAgentRoute />} />
        </Routes>
      </MemoryRouter>
      <ConfirmHost />
    </TooltipProvider>,
  );
}

/** An agent's row on the Agents page. */
const card = (name: string) => screen.getByRole("button", { name }).parentElement as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  catalog = CATALOG;
  agentCatalogs.value = {};
  // A custom ACP agent stored by an older Glade: kept, but never shown (I-159).
  settings.value = { ...defaultSettings(), harnesses: { acp: { agents: [{ id: "mine", name: "Mine", command: "mine-acp", args: ["--stdio"], env: {} }] } } };
  harnesses.value = [PI, MINE];
  mocked.updateSettings.mockImplementation(async () => settings.value);
});

describe("Agents page", () => {
  it("is always called Agents and says which device it belongs to", async () => {
    renderAt("agent");
    expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeTruthy();
    expect(screen.getByLabelText("Device").textContent).toContain("This Mac");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("lists pi and Claude Code only, without install advice or custom ACP agents (I-159)", async () => {
    renderAt("agent");
    await waitFor(() => expect(screen.getByRole("button", { name: "Claude Code" })).toBeTruthy());
    expect(request).toHaveBeenCalledWith("GET", "/agent-catalog");
    const agents = screen.getByRole("heading", { level: 2, name: "Agents" }).closest("section")!;
    expect(within(agents).getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual(["Enable pi", "Enable Claude Code"]);

    const pi = card("pi");
    expect(pi.textContent).toContain("Installed, used for new chats");
    const piSwitch = within(pi).getByRole("switch", { name: "Enable pi" }) as HTMLButtonElement;
    expect(piSwitch.getAttribute("aria-checked")).toBe("true");
    expect(piSwitch.disabled).toBe(false);

    for (const text of ["Install instructions", "npm install", "Other ACP agents", "Add Agent", "Mine", "Gemini", "Codex"]) {
      expect(document.body.textContent, text).not.toContain(text);
    }
  });

  it("a CLI that isn't found: the switch is off and disabled, and says what it looked for (I-159)", async () => {
    renderAt("agent");
    await waitFor(() => expect(screen.getByRole("button", { name: "Claude Code" })).toBeTruthy());
    const claude = card("Claude Code");
    const toggle = within(claude).getByRole("switch", { name: "Enable Claude Code" }) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false"); // stored preference is on, but it isn't found
    expect(toggle.disabled).toBe(true);
    expect(claude.textContent).toContain("Not found: looked for claude on this device's PATH");
  });

  it("turning an agent off saves settings.agents.<id>.enabled and reloads the agents", async () => {
    catalog = [CATALOG[0]!, { ...CATALOG[1]!, installed: true, offered: true }];
    renderAt("agent");
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Claude Code" }).getAttribute("aria-checked")).toBe("true"));
    vi.mocked(request).mockClear();
    fireEvent.click(screen.getByRole("switch", { name: "Enable Claude Code" }));
    await waitFor(() => expect(mocked.updateSettings).toHaveBeenCalledWith({ agents: { claude: { enabled: false } } }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("GET", "/harnesses"));
    expect(request).toHaveBeenCalledWith("GET", "/agent-catalog");
  });

  it("falls back to the harness list (without custom ACP agents) before the catalog loads", () => {
    const list = fallbackCatalog([PI, MINE, { id: "claude", label: "Claude Code", isDefault: false }]);
    expect(list.map((e) => [e.id, e.kind, e.command, e.lookedFor])).toEqual([
      ["pi", "builtin", "pi", ["pi"]],
      ["claude", "builtin", "claude", ["claude"]],
    ]);
  });
});

describe("models per agent (I-155, I-198)", () => {
  const model = (provider: string, id: string, harness?: string): ModelInfo => ({ provider, id, name: id.toUpperCase(), thinkingLevels: ["off"], input: ["text"], harness });

  it("groups models by agent, then provider", () => {
    const groups = groupModelsByAgent([model("openai", "gpt", "pi"), model("anthropic", "haiku", "pi"), model("anthropic", "sonnet")], (h) => (h === "pi" || !h ? "pi" : h));
    expect(groups.map(([g, ms]) => [g, ms.map((m) => m.id)])).toEqual([
      ["pi · anthropic", ["haiku", "sonnet"]],
      ["pi · openai", ["gpt"]],
    ]);
    // A harness's own group label (I-175): "Claude Code", not "Claude Code · anthropic".
    const claude = groupModelsByAgent([{ ...model("anthropic", "opus", "claude"), group: "Claude Code" }, model("openai", "gpt", "pi")], (h) => (h === "claude" ? "Claude Code" : "pi"));
    expect(claude.map(([g]) => g)).toEqual(["Claude Code", "pi · openai"]);
  });

  it("an agent's page lists only its models; hiding one there doesn't hide the other agent's (I-198)", async () => {
    catalog = [CATALOG[0]!, { ...CATALOG[1]!, installed: true, offered: true }];
    harnesses.value = [PI, { id: "claude", label: "Claude Code", isDefault: false, capabilities: CAPS }];
    models.value = [model("anthropic", "opus", "pi"), model("openai", "gpt", "pi"), model("anthropic", "opus", "claude"), model("anthropic", "sonnet", "claude")];
    renderAt("agent/claude");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Claude Code" })).toBeTruthy());
    expect(screen.getByRole("switch", { name: "Show SONNET" })).toBeTruthy();
    expect(screen.queryByRole("switch", { name: "Show GPT" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Show OPUS" }));
    expect(mocked.updateSettings).toHaveBeenCalledWith({ models: { agents: { claude: { hiddenModels: ["anthropic/opus"] } } } });
    expect(settings.value.models.agents.pi).toBeUndefined();
  });

  it("an agent that chooses its own model has no model settings", async () => {
    catalog = [...CATALOG, { id: "acp-mine", label: "Mine", kind: "known", command: "mine-acp", lookedFor: ["mine-acp"], installed: true, enabled: true, offered: true, isDefault: false }];
    renderAt("agent/acp-mine");
    await waitFor(() => expect(screen.getByText("Mine chooses its own model.")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Default model" })).toBeNull();
  });

  it("the quick-tasks model is picked as agent + model, only agents that can run quick tasks (I-198)", async () => {
    harnesses.value = [{ ...PI, capabilities: { ...CAPS, quickTasks: true } }, { id: "claude", label: "Claude Code", isDefault: false, capabilities: CAPS }];
    models.value = [model("anthropic", "claude-haiku-4-5", "pi"), model("anthropic", "sonnet", "claude")];
    renderAt("agent");
    const trigger = screen.getByRole("button", { name: "Quick tasks model" });
    expect(trigger.textContent).toContain("Automatic (pi · CLAUDE-HAIKU-4-5)");
    fireEvent.keyDown(trigger, { key: "Enter" });
    const item = await screen.findByRole("menuitemradio", { name: "CLAUDE-HAIKU-4-5" });
    // Claude Code can't run quick tasks here: its models aren't offered.
    expect(screen.queryByRole("menuitemradio", { name: "SONNET" })).toBeNull();
    fireEvent.click(item);
    expect(mocked.updateSettings).toHaveBeenCalledWith({ models: { quickTasks: { harness: "pi", model: { provider: "anthropic", id: "claude-haiku-4-5" } } } });
  });
});
