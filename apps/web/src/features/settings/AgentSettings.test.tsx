/** Settings → Agents (I-155): every agent with installed/not found, Enable, its settings, install links; models by agent. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { MemoryRouter, Route, Routes } from "react-router";
import { defaultSettings, type AgentCatalogEntry, type HarnessCapabilities, type HarnessInfo, type ModelInfo } from "@glade/protocol";

const CATALOG: AgentCatalogEntry[] = [
  { id: "pi", label: "pi", kind: "builtin", command: "pi", installed: true, enabled: true, offered: true, isDefault: true, installUrl: "https://github.com/earendil-works/pi" },
  { id: "acp-gemini-cli", label: "Gemini CLI", kind: "known", command: "gemini --experimental-acp", installed: true, enabled: false, offered: false, isDefault: false },
  {
    id: "acp-claude-code",
    label: "Claude Code",
    kind: "known",
    command: "claude-agent-acp",
    installed: false,
    enabled: true,
    offered: false,
    isDefault: false,
    installUrl: "https://github.com/agentclientprotocol/claude-agent-acp",
    installHint: "npm install -g @agentclientprotocol/claude-agent-acp",
  },
  { id: "acp-mine", label: "Mine", kind: "custom", command: "mine-acp --stdio", installed: true, enabled: true, offered: true, isDefault: false },
];

vi.mock("@/lib/api", () => ({
  api: { updateSettings: vi.fn(), listModels: vi.fn() },
  request: vi.fn(async (_method: string, path: string) => (path === "/agent-catalog" ? CATALOG : [])),
}));

import { api, request } from "@/lib/api";
import { ConfirmHost, TooltipProvider } from "@/ui";
import { models, settings } from "@/state/store";
import { harnesses } from "@/state/harnesses";
import { agentCatalogs } from "@/state/agent-catalog";
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
  agentCatalogs.value = {};
  settings.value = { ...defaultSettings(), harnesses: { ...defaultSettings().harnesses, acp: { agents: [{ id: "mine", name: "Mine", command: "mine-acp", args: ["--stdio"], env: {} }] } } };
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

  it("lists every agent with its state, Enable switch, settings and install link", async () => {
    renderAt("agent");
    await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Claude Code" })).toBeTruthy());
    expect(request).toHaveBeenCalledWith("GET", "/agent-catalog");

    const pi = card("pi");
    expect(pi.textContent).toContain("Installed, used for new chats");
    expect(within(pi).getByRole("switch", { name: "Enable pi" }).getAttribute("aria-checked")).toBe("true");
    expect(within(pi).getByLabelText("pi executable")).toBeTruthy(); // pi's own settings, inline
    expect(within(pi).queryByText("Install instructions")).toBeNull();

    const gemini = card("Gemini CLI");
    expect(gemini.textContent).toContain("Installed, turned off");
    expect(gemini.textContent).toContain("gemini --experimental-acp");
    expect(within(gemini).getByRole("switch", { name: "Enable Gemini CLI" }).getAttribute("aria-checked")).toBe("false");

    const claude = card("Claude Code");
    expect(claude.textContent).toContain("Not found on This Mac");
    expect(claude.textContent).toContain("npm install -g @agentclientprotocol/claude-agent-acp");
    expect(within(claude).getByText("Install instructions").getAttribute("href")).toBe("https://github.com/agentclientprotocol/claude-agent-acp");

    const mine = card("Mine");
    expect(within(mine).getByRole("button", { name: "Edit Mine" })).toBeTruthy();
    expect(within(mine).getByRole("button", { name: "Remove Mine" })).toBeTruthy();
    expect(screen.getByText("The ones you added are listed above.")).toBeTruthy();
  });

  it("turning an agent on saves settings.agents.<id>.enabled and reloads the agents", async () => {
    renderAt("agent");
    await waitFor(() => expect(screen.getByRole("switch", { name: "Enable Gemini CLI" })).toBeTruthy());
    vi.mocked(request).mockClear();
    fireEvent.click(screen.getByRole("switch", { name: "Enable Gemini CLI" }));
    await waitFor(() => expect(mocked.updateSettings).toHaveBeenCalledWith({ agents: { "acp-gemini-cli": { enabled: true } } }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("GET", "/harnesses"));
    expect(request).toHaveBeenCalledWith("GET", "/agent-catalog");
  });

  it("falls back to the harness list and ACP settings before the catalog loads", () => {
    const list = fallbackCatalog(settings.value, [PI, MINE]);
    expect(list.map((e) => [e.id, e.kind, e.command])).toEqual([
      ["pi", "builtin", "pi"],
      ["acp-mine", "custom", "mine-acp --stdio"],
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
