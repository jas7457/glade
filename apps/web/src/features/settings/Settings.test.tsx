import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { MemoryRouter, Route, Routes, createMemoryRouter, RouterProvider } from "react-router";
import { defaultSettings, type HarnessCapabilities, type HarnessInfo } from "@glade/protocol";

vi.mock("@/lib/api", () => ({
  api: { updateSettings: vi.fn(), listModels: vi.fn(), updateChat: vi.fn() },
}));

import { api } from "@/lib/api";
import { TooltipProvider } from "@/ui";
import { models, settings, workspaces } from "@/state/store";
import { harnesses } from "@/state/harnesses";
import { makeWorkspace } from "@/test/fixtures";
import { SettingsIndexRoute, SettingsRoute } from "./SettingsView";
import { parseArgs } from "./AgentSettings";
import { groupModels } from "./ModelSettings";
import { SettingsNav } from "./SettingsNav";
import { SETTINGS_GROUPS } from "./sections";
import { SETTINGS_SECTIONS, routes } from "@/app/routes";
import { settingsEnvironmentId } from "@/state/env-registry";

const mocked = vi.mocked(api);

const ALL: HarnessCapabilities = { compact: true, exportHtml: true, steering: true, uiRequests: true, usageLimits: true, commands: true, subagents: true, shell: true };
const harness = (id: string, label: string, extra: Partial<HarnessInfo> = {}): HarnessInfo => ({
  id,
  label,
  isDefault: false,
  capabilities: ALL,
  ...extra,
});

/** Blur a field. preact/compat listens for `focusout`, which testing-library's fireEvent.blur doesn't send. */
const leave = (el: HTMLElement) => act(() => void el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

function renderAt(path: string) {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsRoute />} />
        </Routes>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

describe("settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings.value = defaultSettings();
    harnesses.value = [harness("pi", "pi", { isDefault: true })];
    mocked.updateSettings.mockImplementation(async () => settings.value);
  });

  it("General: toggles and segmented controls save via the api", () => {
    renderAt("/settings/general");
    fireEvent.click(screen.getByRole("switch", { name: "Generate chat titles" }));
    expect(mocked.updateSettings).toHaveBeenCalledWith({ general: { generateTitles: false } });
    expect(settings.value.general.generateTitles).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Follow-up" }));
    expect(mocked.updateSettings).toHaveBeenCalledWith({ general: { busyBehavior: "followUp" } });
  });

  it("General: no busy behaviour for a default harness without steering (I-065)", () => {
    harnesses.value = [harness("x", "X", { isDefault: true, capabilities: { ...ALL, steering: false } })];
    renderAt("/settings/general");
    expect(screen.queryByRole("radio", { name: "Follow-up" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Generate chat titles" })).toBeTruthy();
  });

  it("Appearance: theme", () => {
    renderAt("/settings/appearance");
    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    expect(mocked.updateSettings).toHaveBeenCalledWith({ appearance: { theme: "dark" } });
  });

  it("Agent: 'Use sub-agents' is on by default and saves when toggled (I-116)", () => {
    renderAt("/settings/agent");
    const toggle = screen.getByRole("switch", { name: "Use sub-agents" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(mocked.updateSettings).toHaveBeenCalledWith({ agent: { subagents: false } });
    expect(settings.value.agent.subagents).toBe(false);
  });

  it("Agent: extra args are split on whitespace when committed", () => {
    renderAt("/settings/agent");
    const field = screen.getByLabelText("Extra arguments") as HTMLInputElement;
    fireEvent.input(field, { target: { value: " --foo  bar " } });
    expect(mocked.updateSettings).not.toHaveBeenCalled();
    leave(field);
    expect(mocked.updateSettings).toHaveBeenCalledWith({ harnesses: { pi: { extraArgs: ["--foo", "bar"] } } });
  });

  it("Agent: titled after the harness; pi's settings only when pi is installed (I-066)", () => {
    const { unmount } = renderAt("/settings/agent");
    expect(screen.getByRole("heading", { name: "pi" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Agent for new chats" })).toBeNull();
    unmount();
    harnesses.value = [harness("fake", "Fake agent", { isDefault: true })];
    renderAt("/settings/agent");
    expect(screen.getByRole("heading", { name: "Fake agent" })).toBeTruthy();
    expect(screen.queryByLabelText("pi executable")).toBeNull();
    expect(screen.getByLabelText("Idle agents kept running")).toBeTruthy();
  });

  it("Agent: with several harnesses, pick the one for new chats and see each one's settings", () => {
    harnesses.value = [harness("pi", "pi", { isDefault: true }), harness("other", "Other")];
    renderAt("/settings/agent");
    expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "pi" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Agent for new chats" }).textContent).toContain("pi");
  });

  it("Agent: invalid idle count is not saved", () => {
    renderAt("/settings/agent");
    const field = screen.getByLabelText("Idle agents kept running") as HTMLInputElement;
    fireEvent.input(field, { target: { value: "abc" } });
    leave(field);
    expect(mocked.updateSettings).not.toHaveBeenCalled();
  });

  it("Models: hiding a model", () => {
    models.value = [
      { provider: "a", id: "m1", name: "M1", thinkingLevels: ["off"], input: ["text"] },
      { provider: "a", id: "m2", name: "M2", thinkingLevels: ["off"], input: ["text"] },
    ];
    renderAt("/settings/models");
    fireEvent.click(screen.getByRole("switch", { name: "Show M2" }));
    expect(mocked.updateSettings).toHaveBeenCalledWith({ models: { hiddenModels: ["a/m2"] } });
  });

  it("Models: small model and sub-agent model/thinking (I-074, I-078)", async () => {
    models.value = [
      { provider: "a", id: "m1", name: "M1", thinkingLevels: ["off"], input: ["text"] },
      { provider: "a", id: "m2", name: "M2", thinkingLevels: ["off"], input: ["text"] },
    ];
    settings.value = { ...defaultSettings(), models: { ...defaultSettings().models, hiddenModels: ["a/m2"] } };
    renderAt("/settings/models");
    expect(screen.getByText("Small model")).toBeTruthy();
    expect(screen.getByText(/Used for quick tasks: naming chats, summaries and search/)).toBeTruthy();
    const pick = async (select: string, option: RegExp) => {
      const trigger = screen.getByRole("button", { name: select });
      expect(trigger.textContent).toContain("Same as the");
      fireEvent.keyDown(trigger, { key: "Enter" });
      const item = await screen.findByRole("menuitemradio", { name: option });
      // Hidden models aren't offered.
      expect(screen.queryByRole("menuitemradio", { name: "M2" })).toBeNull();
      fireEvent.click(item);
    };
    await pick("Sub-agent model", /^M1$/);
    expect(mocked.updateSettings).toHaveBeenCalledWith({ models: { subagentModel: { provider: "a", id: "m1" } } });
    await pick("Sub-agent thinking", /^Low$/);
    expect(mocked.updateSettings).toHaveBeenCalledWith({ models: { subagentThinkingLevel: "low" } });
  });

  it("Models: the empty state names the harness", () => {
    models.value = [];
    harnesses.value = [harness("other", "Other", { isDefault: true })];
    renderAt("/settings/models");
    expect(screen.getByText(/Check that Other is configured/)).toBeTruthy();
  });

  it("unknown sections redirect to general", () => {
    renderAt("/settings/nope");
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
  });
});

describe("helpers", () => {
  it("parseArgs", () => {
    expect(parseArgs("  -a   b ")).toEqual(["-a", "b"]);
    expect(parseArgs("")).toEqual([]);
  });
  it("groupModels sorts providers and models", () => {
    const g = groupModels([
      { provider: "z", id: "1", name: "B", thinkingLevels: ["off"], input: ["text"] },
      { provider: "a", id: "2", name: "Y", thinkingLevels: ["off"], input: ["text"] },
      { provider: "a", id: "3", name: "X", thinkingLevels: ["off"], input: ["text"] },
    ]);
    expect(g.map(([p, ms]) => [p, ms.map((m) => m.name)])).toEqual([["a", ["X", "Y"]], ["z", ["B"]]]);
  });
});

describe("settings navigation", () => {
  beforeEach(() => {
    harnesses.value = [harness("pi", "pi", { isDefault: true })];
  });

  it("puts every section in exactly one category", () => {
    const grouped = SETTINGS_GROUPS.flatMap((g) => g.sections);
    expect([...grouped].sort()).toEqual([...SETTINGS_SECTIONS].sort());
  });

  it("lists sections under their category headers", () => {
    render(
      <TooltipProvider>
        <MemoryRouter initialEntries={["/settings/agent"]}>
          <SettingsNav />
        </MemoryRouter>
      </TooltipProvider>,
    );
    const app = screen.getByRole("group", { name: "App" });
    const ai = screen.getByRole("group", { name: "AI" });
    expect(app.textContent).toContain("General");
    expect(app.textContent).toContain("Appearance");
    expect(ai.textContent).toContain("Models");
    expect(ai.textContent).toContain("pi");
    expect(screen.getByRole("button", { name: "pi" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Back to App" })).toBeTruthy();
  });
});

describe("settings reopens the last section (I-133)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    settings.value = defaultSettings();
    harnesses.value = [harness("pi", "pi", { isDefault: true })];
  });

  function renderRouter(path: string) {
    const router = createMemoryRouter(
      [
        { path: "/", element: <div>home</div> },
        { path: "/settings", element: <SettingsIndexRoute /> },
        { path: "/settings/:section", element: <SettingsRoute /> },
      ],
      { initialEntries: [path] },
    );
    render(
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>,
    );
    return router;
  }

  it("opens General the first time, then the last section visited", async () => {
    const router = renderRouter("/settings");
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/general"));
    await act(() => router.navigate("/settings/prompts"));
    await act(() => router.navigate("/"));
    await act(() => router.navigate(routes.settings()));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/prompts"));
    expect(screen.getByRole("heading", { name: "Prompts" })).toBeTruthy();
  });

  it("a deep link to a section still wins (and becomes the remembered one)", async () => {
    localStorage.setItem("glade.lastSettings", JSON.stringify({ section: "prompts", envId: null }));
    const router = renderRouter("/settings/appearance");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Appearance" })).toBeTruthy());
    await act(() => router.navigate("/settings"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/appearance"));
  });

  it("falls back to General when the remembered section is gone, and to this machine when its environment is", async () => {
    localStorage.setItem("glade.lastSettings", JSON.stringify({ section: "nope", envId: null }));
    const router = renderRouter("/settings");
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/general"));
    localStorage.setItem("glade.lastSettings", JSON.stringify({ section: "models", envId: "gone" }));
    settingsEnvironmentId.value = "stale";
    await act(() => router.navigate("/settings"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/models"));
    expect(settingsEnvironmentId.value).toBeNull();
  });
});
