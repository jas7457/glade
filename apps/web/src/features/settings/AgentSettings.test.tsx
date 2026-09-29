/** Settings → Agents (I-155, I-159): pi and Claude Code with found/not found and Enable; no install advice; models by agent. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { MemoryRouter, Route, Routes } from "react-router";
import { defaultSettings, type AgentCatalogEntry, type HarnessCapabilities, type HarnessInfo, type ModelInfo } from "@glade/protocol";

const CATALOG: AgentCatalogEntry[] = [
  { id: "pi", label: "pi", kind: "builtin", command: "pi", lookedFor: ["pi"], installed: true, enabled: true, offered: true, isDefault: true },
  {
    id: "acp-claude-code",
    label: "Claude Code",
    kind: "known",
    command: "claude-agent-acp",
    lookedFor: ["claude-agent-acp", "claude-code-acp"],
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
import { SettingsRoute } from "./SettingsView";
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
        </Routes>
      </MemoryRouter>
      <ConfirmHost />
    </TooltipProvider>,
  );
}

const card = (name: string) => screen.getByRole("heading", { level: 2, name }).closest("section") as HTMLElement;

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
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Claude Code" })).toBeTruthy());
    expect(request).toHaveBeenCalledWith("GET", "/agent-catalog");
    expect([...document.querySelectorAll("h2")].map((h) => h.textContent)).toEqual(["pi", "Claude Code"]);

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
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Claude Code" })).toBeTruthy());
    const claude = card("Claude Code");
    const toggle = within(claude).getByRole("switch", { name: "Enable Claude Code" }) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-checked")).toBe("false"); // stored preference is on, but it isn't found
    expect(toggle.disabled).toBe(true);
    expect(claude.textContent).toContain("Not found: looked for claude-agent-acp or claude-code-acp on this device's PATH");
  });

  it("turning an agent off saves settings.agents.<id>.enabled and reloads the agents", async () => {
    catalog = [CATALOG[0]!, { ...CATALOG[1]!, installed: true, offered: true }];
    renderAt("agent");
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Claude Code" }).getAttribute("aria-checked")).toBe("true"));
    vi.mocked(request).mockClear();
    fireEvent.click(screen.getByRole("switch", { name: "Enable Claude Code" }));
    await waitFor(() => expect(mocked.updateSettings).toHaveBeenCalledWith({ agents: { "acp-claude-code": { enabled: false } } }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("GET", "/harnesses"));
    expect(request).toHaveBeenCalledWith("GET", "/agent-catalog");
  });

  it("falls back to the harness list (without custom ACP agents) before the catalog loads", () => {
    const list = fallbackCatalog([PI, MINE, { id: "acp-claude-code", label: "Claude Code", isDefault: false }]);
    expect(list.map((e) => [e.id, e.kind, e.command, e.lookedFor])).toEqual([
      ["pi", "builtin", "pi", ["pi"]],
      ["acp-claude-code", "known", null, ["claude-agent-acp", "claude-code-acp"]],
    ]);
  });
});

describe("Models page (I-155)", () => {
  const model = (provider: string, id: string, harness?: string): ModelInfo => ({ provider, id, name: id.toUpperCase(), thinkingLevels: ["off"], input: ["text"], harness });

  it("groups models by agent, then provider", () => {
    const groups = groupModelsByAgent([model("openai", "gpt", "pi"), model("anthropic", "haiku", "pi"), model("anthropic", "sonnet")], (h) => (h === "pi" || !h ? "pi" : h));
    expect(groups.map(([g, ms]) => [g, ms.map((m) => m.id)])).toEqual([
      ["pi · anthropic", ["haiku", "sonnet"]],
      ["pi · openai", ["gpt"]],
    ]);
  });

  it("shows the agent groups and the agents that choose their own model", () => {
    models.value = [model("anthropic", "haiku", "pi")];
    renderAt("models");
    expect(screen.getByText("pi · anthropic")).toBeTruthy();
    const own = screen.getByText("Mine").parentElement!;
    expect(own.textContent).toContain("Chooses its own model");
  });
});
