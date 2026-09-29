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
import { groupModels } from "./ModelSettings";
import { SettingsNav } from "./SettingsNav";
import { SETTINGS_GROUPS } from "./sections";
import { SETTINGS_SECTIONS, routes } from "@/app/routes";
import { settingsEnvironmentId } from "@/state/env-registry";
import { notificationPermission, notificationPrefs, updateNotificationPrefs } from "@/state/notifications";

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

  it("General: toggles save via the api", () => {
    renderAt("/settings/general");
    fireEvent.click(screen.getByRole("switch", { name: "Generate chat titles" }));
    expect(mocked.updateSettings).toHaveBeenCalledWith({ general: { generateTitles: false } });
    expect(settings.value.general.generateTitles).toBe(false);
  });

  it("General: notification switches are stored on this device, not on the server (I-135)", () => {
    notificationPermission.value = "denied";
    renderAt("/settings/general");
    fireEvent.click(screen.getByRole("switch", { name: "When a chat finishes" }));
    expect(notificationPrefs.value.finished).toBe(false);
    expect(JSON.parse(localStorage.getItem("glade.notifications")!).finished).toBe(false);
    expect(mocked.updateSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/Notifications are blocked/)).toBeTruthy();
    updateNotificationPrefs({ finished: true });
    notificationPermission.value = "default";
  });

  it("General: no send key or busy behaviour settings; the keys are fixed (I-153)", () => {
    renderAt("/settings/general");
    expect(screen.getByRole("switch", { name: "Generate chat titles" })).toBeTruthy();
    expect(screen.queryByText("Send message with")).toBeNull();
    expect(screen.queryByText("While the agent is working")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Send key" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Follow-up" })).toBeNull();
  });

  it("General: the theme switcher (I-161), and no Text size", () => {
    renderAt("/settings/general");
    expect(screen.getByText("Follows your macOS appearance.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    expect(mocked.updateSettings).toHaveBeenCalledWith({ appearance: { theme: "dark" } });
    expect(screen.queryByText("Text size")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Text size" })).toBeNull();
  });

  it("General: the Glade version group comes first, then the theme (I-160, I-161)", () => {
    const { container } = renderAt("/settings/general");
    const titles = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(titles[0]).toBe("Glade");
    const glade = screen.getByRole("heading", { name: "Glade" });
    const theme = screen.getByRole("radiogroup", { name: "Theme" });
    const chats = screen.getByRole("heading", { name: "Chats" });
    expect(glade.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(theme.compareDocumentPosition(chats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(["about", "appearance"])("the removed /settings/%s opens General (I-160, I-161)", (section) => {
    renderAt(`/settings/${section}`);
    expect(screen.getByRole("heading", { level: 1, name: "General" })).toBeTruthy();
  });

  it("Agent: 'Use sub-agents' is on by default and saves when toggled (I-116)", () => {
    renderAt("/settings/agent");
    const toggle = screen.getByRole("switch", { name: "Use sub-agents" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(mocked.updateSettings).toHaveBeenCalledWith({ agent: { subagents: false } });
    expect(settings.value.agent.subagents).toBe(false);
  });

  it("Agent: no pi executable, extra arguments, auto-compaction, auto-retry or idle settings (I-159)", () => {
    renderAt("/settings/agent");
    for (const label of ["pi executable", "Extra arguments", "Auto-compaction", "Auto-retry", "Idle agents kept running"]) {
      expect(screen.queryByLabelText(label), label).toBeNull();
      expect(screen.queryByText(label), label).toBeNull();
    }
  });

  it("Agent: a card per harness, titled after it (I-066)", () => {
    const { unmount } = renderAt("/settings/agent");
    expect(screen.getByRole("heading", { name: "pi" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Agent for new chats" })).toBeNull();
    unmount();
    harnesses.value = [harness("fake", "Fake agent", { isDefault: true })];
    renderAt("/settings/agent");
    expect(screen.getByRole("heading", { name: "Fake agent" })).toBeTruthy();
  });

  it("Agent: with several harnesses, pick the one for new chats and see each one's settings", () => {
    harnesses.value = [harness("pi", "pi", { isDefault: true }), harness("other", "Other")];
    renderAt("/settings/agent");
    expect(screen.getByRole("heading", { level: 1, name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "pi" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Agent for new chats" }).textContent).toContain("pi");
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
    // About and Appearance were folded into General (I-160, I-161).
    expect(app.textContent).not.toContain("Appearance");
    expect(app.textContent).not.toContain("About");
    expect(ai.textContent).toContain("Models");
    // Always "Agents" (I-155), not the harness's name.
    expect(ai.textContent).toContain("Agents");
    expect(screen.getByRole("button", { name: "Agents" }).getAttribute("aria-current")).toBe("page");
    // One device: no device switcher.
    expect(screen.queryByRole("button", { name: "Settings for device" })).toBeNull();
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
    const router = renderRouter("/settings/remote");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Remote Access" })).toBeTruthy());
    await act(() => router.navigate("/settings"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/remote"));
  });

  it("falls back to General when the remembered section is gone, and to this machine when its environment is", async () => {
    localStorage.setItem("glade.lastSettings", JSON.stringify({ section: "nope", envId: null }));
    const router = renderRouter("/settings");
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/general"));
    // The removed About / Appearance pages (I-160, I-161).
    for (const section of ["about", "appearance"]) {
      localStorage.setItem("glade.lastSettings", JSON.stringify({ section, envId: null }));
      await act(() => router.navigate("/settings"));
      await waitFor(() => expect(router.state.location.pathname).toBe("/settings/general"));
    }
    localStorage.setItem("glade.lastSettings", JSON.stringify({ section: "models", envId: "gone" }));
    settingsEnvironmentId.value = "stale";
    await act(() => router.navigate("/settings"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/models"));
    expect(settingsEnvironmentId.value).toBeNull();
  });
});
