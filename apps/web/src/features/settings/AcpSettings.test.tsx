/** Settings → Agents → ACP agents (I-119): add, edit and remove agents; argument/env parsing. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { MemoryRouter, Route, Routes } from "react-router";
import { defaultSettings, type AcpAgentConfig } from "@glade/protocol";

vi.mock("@/lib/api", () => ({
  api: { updateSettings: vi.fn() },
  request: vi.fn(async () => []),
}));

import { api } from "@/lib/api";
import { ConfirmHost, TooltipProvider } from "@/ui";
import { settings } from "@/state/store";
import { harnesses } from "@/state/harnesses";
import { SettingsRoute } from "./SettingsView";
import { formatEnv, joinArgs, parseEnv, splitArgs } from "./AcpSettings";

const mocked = vi.mocked(api);

const GEMINI: AcpAgentConfig = { id: "gemini-cli", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"], env: {} };

function renderAgents() {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/settings/agent"]}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsRoute />} />
        </Routes>
      </MemoryRouter>
      <ConfirmHost />
    </TooltipProvider>,
  );
}

const saved = () => (mocked.updateSettings.mock.calls.at(-1)?.[0] as { harnesses: { acp: { agents: AcpAgentConfig[] } } }).harnesses.acp.agents;

beforeEach(() => {
  vi.clearAllMocks();
  settings.value = defaultSettings();
  harnesses.value = [{ id: "pi", label: "pi", isDefault: true, capabilities: { compact: true, exportHtml: true, steering: true, uiRequests: true, usageLimits: true, commands: true, subagents: true, shell: true } }];
  mocked.updateSettings.mockImplementation(async () => settings.value);
});

describe("ACP agent settings", () => {
  it("has no agents by default and explains what adding one means", () => {
    renderAgents();
    expect(screen.getByText("No ACP agents yet.")).toBeTruthy();
    expect(screen.getByText(/Glade starts this command when you use it; it may use your account\/subscription/)).toBeTruthy();
  });

  it("adds an agent with arguments and environment", async () => {
    renderAgents();
    fireEvent.click(screen.getByRole("button", { name: "Add Agent" }));
    expect(screen.getByRole("dialog").textContent).toContain("it may use your account/subscription");
    const add = screen.getByRole("button", { name: "Add agent" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Gemini CLI" } });
    fireEvent.input(screen.getByLabelText("Command"), { target: { value: " gemini " } });
    fireEvent.input(screen.getByLabelText(/Arguments/), { target: { value: '--experimental-acp --title "My agent"' } });
    fireEvent.input(screen.getByLabelText(/Environment/), { target: { value: "not valid" } });
    expect(screen.getByText(/Not a KEY=value line/)).toBeTruthy();
    expect(add.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText(/Environment/), { target: { value: "GEMINI_MODEL=pro\n" } });
    fireEvent.click(add);
    await waitFor(() => expect(mocked.updateSettings).toHaveBeenCalled());
    expect(saved()).toEqual([
      { id: "gemini-cli", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp", "--title", "My agent"], env: { GEMINI_MODEL: "pro" } },
    ]);
  });

  it("edits and removes an agent", async () => {
    settings.value = { ...defaultSettings(), harnesses: { ...defaultSettings().harnesses, acp: { agents: [GEMINI] } } };
    renderAgents();
    expect(screen.getByText("gemini --experimental-acp")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Gemini CLI" }));
    fireEvent.input(screen.getByLabelText("Name"), { target: { value: "Gemini" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocked.updateSettings).toHaveBeenCalledTimes(1));
    expect(saved()).toEqual([{ ...GEMINI, name: "Gemini" }]);

    settings.value = { ...defaultSettings(), harnesses: { ...defaultSettings().harnesses, acp: { agents: [GEMINI] } } };
    fireEvent.click(await screen.findByRole("button", { name: "Remove Gemini CLI" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocked.updateSettings).toHaveBeenCalledTimes(2));
    expect(saved()).toEqual([]);
  });
});

describe("argument and environment parsing", () => {
  it("splits and joins arguments with quotes", () => {
    expect(splitArgs(`a "b c" 'd e' f\\"g "h \\"i\\""`)).toEqual(["a", "b c", "d e", 'f\\"g', 'h "i"']);
    expect(splitArgs(joinArgs(["x", "two words", 'q"uote', ""]))).toEqual(["x", "two words", 'q"uote', ""]);
  });

  it("parses KEY=value lines", () => {
    expect(parseEnv("A=1\n# comment\n\nB = two=2")).toEqual({ env: { A: "1", B: " two=2" }, error: null });
    expect(parseEnv("=x").error).toMatch(/Not a KEY=value/);
    expect(formatEnv({ A: "1", B: "2" })).toBe("A=1\nB=2");
  });
});
