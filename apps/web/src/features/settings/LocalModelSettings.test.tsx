/**
 * I-196: Settings → Local Models for the device picked in the switcher. On another Mac Load/Unload
 * still work (actions, not settings) while the Server URL is view only; on this Mac the URL saves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { MemoryRouter } from "react-router";

vi.mock("@glade/app-core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@glade/app-core/lib/api")>();
  return { ...actual, api: { getLocalModels: vi.fn(), loadLocalModel: vi.fn(), unloadLocalModel: vi.fn(), updateSettings: vi.fn() } };
});

import { defaultSettings } from "@glade/protocol";
import { api } from "@glade/app-core/lib/api";
import { TooltipProvider } from "@glade/app-core/ui";
import { settingsEnvironmentId } from "@glade/app-core/state/env-registry";
import { localModels } from "@glade/app-core/state/local-models";
import { settings } from "@glade/app-core/state/store";
import { fakeEnv, resetEnvironmentsForTest, useEnvironments } from "@glade/app-core/test/env-fixtures";
import { makeLocalModel, makeLocalModelsState } from "@glade/app-core/test/local-models-fixtures";
import { SettingsView } from "./SettingsView";
import { validateServerUrl } from "./LocalModelSettings";

const mocked = vi.mocked(api);
const STATE = makeLocalModelsState([makeLocalModel("small", { name: "Small" })]);

function renderPage() {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/settings/local-models"]}>
        <SettingsView section="local-models" />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localModels.value = new Map();
  settings.value = defaultSettings();
  mocked.getLocalModels.mockResolvedValue(STATE);
  mocked.loadLocalModel.mockResolvedValue(STATE);
  mocked.updateSettings.mockImplementation(async (patch) => ({ ...settings.value, ...(patch as object) }) as never);
});
afterEach(() => resetEnvironmentsForTest());

describe("Settings → Local Models", () => {
  it("on another Mac: Load works there, the Server URL is view only", async () => {
    const loadLocalModel = vi.fn(async () => STATE);
    useEnvironments(fakeEnv({ id: "studio", name: "Studio", api: { getLocalModels: vi.fn(async () => STATE), loadLocalModel } }));
    settingsEnvironmentId.value = "studio";
    renderPage();
    const load = await screen.findByRole("button", { name: "Load Small" });
    expect(load.closest("fieldset[disabled]")).toBeNull();
    fireEvent.click(load);
    await waitFor(() => expect(loadLocalModel).toHaveBeenCalledWith("small", undefined));
    expect(mocked.loadLocalModel).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("View only. Change this on Studio.")).toBeTruthy();
  });

  it("on this Mac: the Server URL saves and the panel asks the new address", async () => {
    useEnvironments();
    renderPage();
    const field = (await screen.findByLabelText("Server URL")) as HTMLInputElement;
    expect(field.disabled).toBe(false);
    expect(field.value).toBe("http://127.0.0.1:8080");
    fireEvent.input(field, { target: { value: "http://127.0.0.1:9090" } });
    act(() => void fireEvent.keyDown(field, { key: "Enter" }));
    await waitFor(() => expect(mocked.updateSettings).toHaveBeenCalledWith({ localModels: { url: "http://127.0.0.1:9090" } }));
    await waitFor(() => expect(mocked.getLocalModels).toHaveBeenCalledTimes(2));
  });

  it("validates the address", () => {
    expect(validateServerUrl("http://127.0.0.1:8080")).toBeNull();
    expect(validateServerUrl("")).toBeNull();
    expect(validateServerUrl("ftp://x")).toMatch(/http/);
    expect(validateServerUrl("nope")).toMatch(/valid/);
  });
});
