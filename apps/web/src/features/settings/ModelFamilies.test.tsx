/**
 * I-207: an agent's Models list grouped by family (A–Z, newest first, "N of M shown") with a
 * filter box (name or id, Esc clears, "No models match"); switches work while filtered, and the
 * filter works on another device's (view-only) page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { MemoryRouter, Route, Routes } from "react-router";
import { defaultSettings, type HarnessCapabilities, type ModelInfo } from "@glade/protocol";

vi.mock("@glade/app-core/lib/api", () => ({
  api: { updateSettings: vi.fn(), listModels: vi.fn() },
}));

import { api } from "@glade/app-core/lib/api";
import { TooltipProvider } from "@glade/app-core/ui";
import { models, settings } from "@glade/app-core/state/store";
import { harnesses } from "@glade/app-core/state/harnesses";
import { SettingsAgentRoute } from "./SettingsView";
import { AgentModelGroups } from "./ModelSettings";

const mocked = vi.mocked(api);
const CAPS: HarnessCapabilities = { compact: true, exportHtml: true, steering: true, uiRequests: true, usageLimits: true, commands: true, subagents: true, shell: true };

const model = (provider: string, id: string, name: string): ModelInfo => ({ provider, id, name, thinkingLevels: ["off"], input: ["text"] });
const MODELS: ModelInfo[] = [
  model("anthropic", "claude-opus-4-5-20251101", "Claude Opus 4.5"),
  model("anthropic", "claude-opus-5-5", "Claude Opus 5.5"),
  model("anthropic", "claude-opus-4-5", "Claude Opus 4.5 (latest)"),
  model("anthropic", "claude-haiku-4-5", "Claude Haiku 4.5 (latest)"),
  model("anthropic", "claude-haiku-5-5", "Claude Haiku 5.5"),
  model("openai-codex", "gpt-6.1-sol", "GPT-6.1-Sol"),
  model("openai-codex", "gpt-5.6-sol", "GPT-5.6-Sol"),
  model("openai-codex", "gpt-5.5", "GPT-5.5"),
];

function renderPage() {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/settings/agent/pi"]}>
        <Routes>
          <Route path="/settings/agent/:harness" element={<SettingsAgentRoute />} />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

/** Family headers and model switches in the order shown. */
function listed(): string[] {
  return screen.getAllByRole("group", { name: /./ }).flatMap((g) => [
    `# ${g.getAttribute("aria-label")} · ${g.firstElementChild?.lastElementChild?.textContent}`,
    ...within(g)
      .getAllByRole("switch")
      .map((s) => s.getAttribute("aria-label")!.replace(/^Show /, "")),
  ]);
}

const filter = () => screen.getByRole("textbox", { name: "Filter models" }) as HTMLInputElement;
const type = (text: string) => fireEvent.input(filter(), { target: { value: text } });

describe("Models list: families and filter (I-207)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.value = { ...defaultSettings(), models: { quickTasks: null, agents: { pi: { hiddenModels: ["anthropic/claude-opus-4-5-20251101", "anthropic/claude-opus-4-5"] } } } };
    harnesses.value = [{ id: "pi", label: "pi", isDefault: true, capabilities: CAPS }];
    models.value = MODELS;
    mocked.updateSettings.mockImplementation(async () => settings.value);
  });

  it("groups each provider's models by family, A–Z, newest first, with N of M shown", () => {
    renderPage();
    expect(listed()).toEqual([
      "# Claude Haiku · 2 of 2 shown",
      "Claude Haiku 5.5",
      "Claude Haiku 4.5 (latest)",
      "# Claude Opus · 1 of 3 shown",
      "Claude Opus 5.5",
      "Claude Opus 4.5 (latest)",
      "Claude Opus 4.5",
      "# GPT · 1 of 1 shown",
      "GPT-5.5",
      "# GPT Sol · 2 of 2 shown",
      "GPT-6.1-Sol",
      "GPT-5.6-Sol",
    ]);
    // Provider headers stay.
    expect(screen.getByText("anthropic")).toBeTruthy();
    expect(screen.getByText("openai-codex")).toBeTruthy();
  });

  it("filters live by name or id; empty families and providers are hidden; Esc clears", () => {
    renderPage();
    type("SOL");
    expect(listed()).toEqual(["# GPT Sol · 2 of 2 shown", "GPT-6.1-Sol", "GPT-5.6-Sol"]);
    expect(screen.queryByText("anthropic")).toBeNull();

    type("opus-4-5");
    // Matches ids; the header still counts the whole family.
    expect(listed()).toEqual(["# Claude Opus · 1 of 3 shown", "Claude Opus 4.5 (latest)", "Claude Opus 4.5"]);

    type("gemini");
    expect(screen.getByText("No models match “gemini”.")).toBeTruthy();
    expect(screen.queryAllByRole("switch", { name: /^Show / })).toHaveLength(0);

    fireEvent.keyDown(filter(), { key: "Escape" });
    expect(filter().value).toBe("");
    expect(listed()).toHaveLength(12);
  });

  it("switches still work while filtered", () => {
    renderPage();
    type("opus 5.5");
    expect(listed()).toEqual(["# Claude Opus · 1 of 3 shown", "Claude Opus 5.5"]);
    fireEvent.click(screen.getByRole("switch", { name: "Show Claude Opus 5.5" }));
    expect(mocked.updateSettings).toHaveBeenCalledWith({
      models: { agents: { pi: { hiddenModels: ["anthropic/claude-opus-4-5-20251101", "anthropic/claude-opus-4-5", "anthropic/claude-opus-5-5"] } } },
    });
    expect(screen.getByRole("group", { name: "Claude Opus" }).textContent).toContain("0 of 3 shown");
  });

  it("a model that is its own family gets no header", () => {
    models.value = [...MODELS, model("openai-codex", "gpt-daybreak-blue-latest", "Daybreak Blue")];
    renderPage();
    expect(screen.queryByRole("group", { name: "Daybreak Blue" })).toBeNull();
    expect(screen.getAllByText("Daybreak Blue")).toHaveLength(1);
    expect(screen.getByRole("switch", { name: "Show Daybreak Blue" })).toBeTruthy();
  });

  it("view only (another device): the filter works, the switches don't", () => {
    render(
      <TooltipProvider>
        <AgentModelGroups harness="pi" readOnly />
      </TooltipProvider>,
    );
    expect(filter().disabled).toBe(false);
    type("haiku");
    expect(listed()).toEqual(["# Claude Haiku · 2 of 2 shown", "Claude Haiku 5.5", "Claude Haiku 4.5 (latest)"]);
    expect(screen.getByRole("switch", { name: "Show Claude Haiku 5.5" }).closest("fieldset")?.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Default model" }).closest("fieldset")?.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Refresh Models" }).hasAttribute("disabled")).toBe(true);
  });
});
