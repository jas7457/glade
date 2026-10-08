/**
 * I-201: Settings → Agents → <agent> → Advanced: off by default with the command hidden; on shows
 * the Command field (default as placeholder) and Test; Glade's own flags are refused under the
 * field; Test runs `<command> --version` on the device; another device's page is view only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";

vi.mock("@glade/app-core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@glade/app-core/lib/api")>();
  return { ...actual, api: { updateSettings: vi.fn() }, request: vi.fn() };
});

import { defaultSettings, deepMerge, type AgentCatalogEntry, type AgentCommandTestResult, type DeepPartial, type Settings } from "@glade/protocol";
import { api, request } from "@glade/app-core/lib/api";
import { TooltipProvider } from "@glade/app-core/ui";
import { settingsEnvironmentId } from "@glade/app-core/state/env-registry";
import { settings } from "@glade/app-core/state/store";
import { fakeEnv, resetEnvironmentsForTest, useEnvironments } from "@glade/app-core/test/env-fixtures";
import { AgentAdvancedGroup } from "./AgentAdvanced";

const mocked = vi.mocked(api);
const requested = vi.mocked(request);
const PI: AgentCatalogEntry = { id: "pi", label: "pi", kind: "builtin", command: "pi", lookedFor: ["pi"], installed: true, enabled: true, offered: true, isDefault: true };
let testResult: AgentCommandTestResult;

function renderGroup(entry = PI) {
  return render(
    <TooltipProvider>
      <AgentAdvancedGroup entry={entry} />
    </TooltipProvider>,
  );
}
const advancedSwitch = () => screen.getByRole("switch", { name: "Advanced settings for pi" });
const field = () => screen.queryByLabelText("Command") as HTMLInputElement | null;

beforeEach(() => {
  vi.clearAllMocks();
  useEnvironments();
  settings.value = defaultSettings();
  testResult = { ok: true, command: "mywrapper pi --version", version: "0.80.1", output: "0.80.1" };
  mocked.updateSettings.mockImplementation(async (patch) => (settings.value = deepMerge(settings.value, patch as DeepPartial<Settings>)));
  requested.mockImplementation((async (_method: string, path: string) => (path === "/agent-command/test" ? testResult : [])) as never);
});
afterEach(() => resetEnvironmentsForTest());

describe("Advanced: custom command (I-201)", () => {
  it("is off by default with the command hidden; switching on saves advanced and shows the field with the default as placeholder", async () => {
    renderGroup();
    expect(advancedSwitch().getAttribute("aria-checked")).toBe("false");
    expect(field()).toBeNull();
    expect(screen.queryByRole("button", { name: "Test" })).toBeNull();

    fireEvent.click(advancedSwitch());
    await waitFor(() => expect(mocked.updateSettings).toHaveBeenCalledWith({ agents: { pi: { advanced: true } } }));
    await waitFor(() => expect(field()).toBeTruthy());
    expect(field()!.placeholder).toBe("pi");
    expect(screen.getByText(/must pass the arguments through and leave stdin and stdout alone/)).toBeTruthy();
  });

  it("saves the command on Enter; switching off keeps it, switching on shows it again", async () => {
    settings.value = { ...defaultSettings(), agents: { pi: { advanced: true } } };
    renderGroup();
    fireEvent.input(field()!, { target: { value: "  mywrapper pi --offline " } });
    act(() => void fireEvent.keyDown(field()!, { key: "Enter" }));
    await waitFor(() => expect(mocked.updateSettings).toHaveBeenCalledWith({ agents: { pi: { command: "mywrapper pi --offline" } } }));

    fireEvent.click(advancedSwitch());
    await waitFor(() => expect(field()).toBeNull());
    expect(settings.value.agents.pi).toEqual({ advanced: false, command: "mywrapper pi --offline" });
    fireEvent.click(advancedSwitch());
    await waitFor(() => expect(field()?.value).toBe("mywrapper pi --offline"));
  });

  it("refuses Glade's own flags with a message under the field (not saved, no Test)", async () => {
    settings.value = { ...defaultSettings(), agents: { pi: { advanced: true } } };
    renderGroup();
    fireEvent.input(field()!, { target: { value: "mywrapper pi --mode json" } });
    expect(screen.getByRole("alert").textContent).toBe("`--mode` is set by Glade: remove it from the command.");
    expect(field()!.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: "Test" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.blur(field()!);
    expect(mocked.updateSettings).not.toHaveBeenCalled();
  });

  it("Test runs `<command> --version` with what's in the field and shows the result", async () => {
    settings.value = { ...defaultSettings(), agents: { pi: { advanced: true, command: "mywrapper pi" } } };
    renderGroup();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByTestId("agent-command-test").textContent).toContain("Works: 0.80.1"));
    expect(requested).toHaveBeenCalledWith("POST", "/agent-command/test", { harness: "pi", command: "mywrapper pi" });
    expect(screen.getByTestId("agent-command-test").textContent).toContain("$ mywrapper pi --version");

    testResult = { ok: false, command: "nope pi --version", version: null, output: "", error: "`nope` wasn't found on this device's PATH." };
    fireEvent.input(field()!, { target: { value: "nope pi" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(screen.getByTestId("agent-command-test").getAttribute("data-ok")).toBe("false"));
    expect(screen.getByTestId("agent-command-test").textContent).toContain("`nope` wasn't found on this device's PATH.");
  });

  it("another device: view only (switch and field disabled), shows its command", async () => {
    const studio = fakeEnv({ id: "studio", name: "Studio" });
    studio.shell.settings.value = { ...defaultSettings(), agents: { pi: { advanced: true, command: "mywrapper pi" } } };
    useEnvironments(studio);
    settingsEnvironmentId.value = "studio";
    renderGroup();
    expect((advancedSwitch() as HTMLButtonElement).disabled).toBe(true);
    expect(field()!.value).toBe("mywrapper pi");
    expect(field()!.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Test" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("View only. Change this on Studio.")).toBeTruthy();
  });

  it("agents without a built-in command have no Advanced group", () => {
    const { container } = renderGroup({ ...PI, id: "fake", label: "Fake", command: null, lookedFor: [] });
    expect(container.textContent).toBe("");
  });
});
