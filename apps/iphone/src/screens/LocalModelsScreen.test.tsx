/** I-196: a paired Mac's Local Models on the iPhone (row in the device screen, list, load/unload). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { RouterProvider, createMemoryRouter } from "react-router";
import type { LocalModelsState } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { connections } from "@glade/app-core/state/env-registry";
import { handleLocalModelsMessage, localModels, localModelsFetchError } from "@glade/app-core/state/local-models";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { GiB, makeLocalModel, makeLocalModelsState } from "@glade/app-core/test/local-models-fixtures";
import { paths } from "~/app/routes";
import { fakeEnv } from "~/test/fake-env";
import { DeviceScreen } from "./DeviceScreen";
import { LocalModelsScreen } from "./LocalModelsScreen";

const STATE = makeLocalModelsState([
  makeLocalModel("qwen", { name: "Qwen", status: "loaded", sizeBytes: 19 * GiB, usedBy: { chats: 1, working: 0 } }),
  makeLocalModel("small", { name: "Small", sizeBytes: 4 * GiB }),
  makeLocalModel("huge", { name: "Huge", sizeBytes: 90 * GiB }),
]);

let api: Record<string, ReturnType<typeof vi.fn>>;

function setup(state: LocalModelsState = STATE) {
  api = { getLocalModels: vi.fn(async () => state), loadLocalModel: vi.fn(async () => state), unloadLocalModel: vi.fn(async () => state) };
  connections.value = [{ ...fakeEnv("m1", "Studio"), api: api as never }];
  savedEnvironments.value = [{ id: "m1", name: "Studio", urls: ["http://m1.test:4327"], token: "t" }];
}

function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      { path: "/settings/devices/:envId", element: <DeviceScreen /> },
      { path: "/settings/devices/:envId/local-models", element: <LocalModelsScreen /> },
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

beforeEach(() => {
  localModels.value = new Map();
  localModelsFetchError.value = new Map();
});

describe("iPhone local models", () => {
  it("the device screen has a Local Models row with how many are loaded", () => {
    setup();
    handleLocalModelsMessage(STATE, "m1");
    const router = renderAt(paths.device("m1"));
    fireEvent.click(screen.getByRole("button", { name: /Local Models\s*1 loaded/ }));
    expect(router.state.location.pathname).toBe(paths.localModels("m1"));
  });

  it("lists the models and loads one", async () => {
    setup();
    renderAt(paths.localModels("m1"));
    expect(await screen.findByText("Loaded 19.0 GB of ~96 GB")).toBeTruthy();
    expect(api.getLocalModels).toHaveBeenCalledWith(true);
    const rows = screen.getAllByTestId("local-model");
    expect(within(rows[0]!).getByText("Loaded")).toBeTruthy();
    expect(within(rows[0]!).getByText("19.0 GB · 32k context · Used by 1 chat")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load Small" }));
    await waitFor(() => expect(api.loadLocalModel).toHaveBeenCalledWith("small", undefined));
  });

  it("asks in a sheet before unloading a model a chat uses", async () => {
    setup();
    renderAt(paths.localModels("m1"));
    fireEvent.click(await screen.findByRole("button", { name: "Unload Qwen" }));
    const sheet = await screen.findByRole("dialog", { name: "Unload Qwen?" });
    expect(within(sheet).getByText(/1 chat uses it/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Unload" }));
    await waitFor(() => expect(api.unloadLocalModel).toHaveBeenCalledWith("qwen"));
  });

  it("warns before a load that may not fit; Cancel keeps it unloaded", async () => {
    setup();
    renderAt(paths.localModels("m1"));
    fireEvent.click(await screen.findByRole("button", { name: "Load Huge" }));
    const sheet = await screen.findByRole("dialog", { name: "Load Huge?" });
    expect(within(sheet).getByText(/This may not fit: 90.0 GB more/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.loadLocalModel).not.toHaveBeenCalled();
  });

  it("shows setup help when llama-server isn't running", async () => {
    setup(makeLocalModelsState([], { reachable: false, error: "llama-server isn't running." }));
    renderAt(paths.localModels("m1"));
    expect(await screen.findByText("llama-server isn't running.")).toBeTruthy();
    expect(document.querySelector("code")!.textContent).toMatch(/^llama-server --models-dir/);
  });
});
