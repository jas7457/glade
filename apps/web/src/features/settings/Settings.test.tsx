import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/preact";
import { MemoryRouter, Route, Routes } from "react-router";
import { defaultSettings } from "@pi-ui/protocol";

vi.mock("@/lib/api", () => ({
  api: { updateSettings: vi.fn(), listModels: vi.fn(), updateChat: vi.fn() },
}));

import { api } from "@/lib/api";
import { TooltipProvider } from "@/ui";
import { chats, models, settings } from "@/state/store";
import { makeChat } from "@/test/fixtures";
import { SettingsRoute } from "./SettingsView";
import { parseArgs } from "./AgentSettings";
import { groupModels } from "./ModelSettings";

const mocked = vi.mocked(api);

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

  it("Appearance: theme", () => {
    renderAt("/settings/appearance");
    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    expect(mocked.updateSettings).toHaveBeenCalledWith({ appearance: { theme: "dark" } });
  });

  it("Agent: extra args are split on whitespace when committed", () => {
    renderAt("/settings/agent");
    const field = screen.getByLabelText("Extra arguments") as HTMLInputElement;
    fireEvent.input(field, { target: { value: " --foo  bar " } });
    expect(mocked.updateSettings).not.toHaveBeenCalled();
    leave(field);
    expect(mocked.updateSettings).toHaveBeenCalledWith({ agent: { extraArgs: ["--foo", "bar"] } });
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
