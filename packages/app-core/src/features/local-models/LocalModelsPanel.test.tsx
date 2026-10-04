/**
 * I-196: the Local Models panel on another Mac — rows with status, Load/Unload calls, the
 * question before unloading a model chats use, the over-budget warning, the not-running state,
 * and live updates from the environment's `local_models` push.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { LocalModelsState } from "@glade/protocol";
import { ConfirmHost, TooltipProvider } from "@glade/app-core/ui";
import { fakeEnv, resetEnvironmentsForTest, useEnvironments } from "@glade/app-core/test/env-fixtures";
import { GiB, makeLocalModel, makeLocalModelsState } from "@glade/app-core/test/local-models-fixtures";
import { localModels, localModelsFetchError } from "@glade/app-core/state/local-models";
import { handleServerMessage } from "@glade/app-core/state/store";
import { LocalModelsPanel } from "./LocalModelsPanel";

const STATE = makeLocalModelsState([
  makeLocalModel("qwen", { name: "Qwen3.8-27B", status: "loaded", sizeBytes: 19 * GiB, usedBy: { chats: 2, working: 1 } }),
  makeLocalModel("gemma", { name: "Gemma", status: "loading", sizeBytes: 17.9 * GiB }),
  makeLocalModel("sleepy", { status: "sleeping", contextLength: null }),
  makeLocalModel("broken", { status: "failed", error: "out of memory" }),
  makeLocalModel("huge", { name: "Huge", sizeBytes: 70 * GiB }),
  makeLocalModel("small", { name: "Small", sizeBytes: 4 * GiB }),
]);

let api: { getLocalModels: ReturnType<typeof vi.fn>; loadLocalModel: ReturnType<typeof vi.fn>; unloadLocalModel: ReturnType<typeof vi.fn> };

function setup(state: LocalModelsState | Error = STATE) {
  api = {
    getLocalModels: vi.fn(async () => {
      if (state instanceof Error) throw state;
      return state;
    }),
    loadLocalModel: vi.fn(async () => STATE),
    unloadLocalModel: vi.fn(async () => STATE),
  };
  useEnvironments(fakeEnv({ id: "studio", name: "Mac Studio", api }));
  return render(
    <TooltipProvider>
      <LocalModelsPanel envId="studio" />
      <ConfirmHost />
    </TooltipProvider>,
  );
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-model="${id}"]`)!;

beforeEach(() => {
  localModels.value = new Map();
  localModelsFetchError.value = new Map();
});
afterEach(() => resetEnvironmentsForTest());

describe("LocalModelsPanel", () => {
  it("refreshes on open and shows backend, memory and each model's status", async () => {
    setup();
    await screen.findByText("llama-server · 127.0.0.1:8080");
    expect(api.getLocalModels).toHaveBeenCalledWith(true);
    // 19 + 17.9 (loading counts) of 96.
    expect(screen.getByText("Loaded 36.9 GB of ~96 GB")).toBeTruthy();
    expect(within(row("qwen")).getByText("Loaded")).toBeTruthy();
    expect(within(row("qwen")).getByText("19.0 GB · 32k context · Used by 2 chats")).toBeTruthy();
    expect(within(row("qwen")).getByRole("button", { name: "Unload Qwen3.8-27B" })).toBeTruthy();
    expect(within(row("gemma")).getByText("Loading…")).toBeTruthy();
    expect(within(row("gemma")).getByRole("button", { name: "Cancel loading Gemma" })).toBeTruthy();
    expect(within(row("sleepy")).getByText("Sleeping")).toBeTruthy();
    expect(within(row("sleepy")).getByText("10.0 GB")).toBeTruthy();
    expect(within(row("broken")).getByText("out of memory")).toBeTruthy();
    expect(within(row("broken")).getByRole("button", { name: "Load broken" })).toBeTruthy();
    expect(within(row("small")).queryByText(/Loaded|Loading|Sleeping|Failed/)).toBeNull();
  });

  it("loads a model that fits right away", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Load Small" }));
    await waitFor(() => expect(api.loadLocalModel).toHaveBeenCalledWith("small", undefined));
  });

  it("asks before a load that may not fit, and still allows it", async () => {
    setup();
    await screen.findByRole("button", { name: "Load Huge" });
    expect(within(row("huge")).getByText("May not fit in memory")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load Huge" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("This may not fit: 70.0 GB more with 36.9 GB loaded of ~96 GB. Unload a model first?")).toBeTruthy();
    expect(api.loadLocalModel).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Load Anyway" }));
    await waitFor(() => expect(api.loadLocalModel).toHaveBeenCalledWith("huge", undefined));
  });

  it("asks before unloading a model a chat is working with; Cancel keeps it", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Unload Qwen3.8-27B" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Unload Qwen3.8-27B?")).toBeTruthy();
    expect(within(dialog).getByText("1 chat is working with it.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.unloadLocalModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Unload Qwen3.8-27B" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Unload" }));
    await waitFor(() => expect(api.unloadLocalModel).toHaveBeenCalledWith("qwen"));
  });

  it("unloads an unused model and cancels a load without asking", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Unload sleepy" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel loading Gemma" }));
    await waitFor(() => expect(api.unloadLocalModel.mock.calls).toEqual([["sleepy"], ["gemma"]]));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows why llama-server can't be reached and how to start it", async () => {
    setup(makeLocalModelsState([], { reachable: false, error: "llama-server isn't running at http://127.0.0.1:8080." }));
    expect(await screen.findByText("llama-server isn't running at http://127.0.0.1:8080.")).toBeTruthy();
    expect(screen.getByText("Start llama-server in router mode:")).toBeTruthy();
    expect(document.querySelector("code")!.textContent).toMatch(/^llama-server --models-dir ~\/models --no-models-autoload --models-max 0 /);
    expect(screen.getByText("Glade looks for it at http://127.0.0.1:8080.")).toBeTruthy();
    expect(screen.queryByText(/Loaded .* of/)).toBeNull();
  });

  it("says when llama-server has no models", async () => {
    setup(makeLocalModelsState([]));
    expect(await screen.findByText("No models in llama-server's models folder")).toBeTruthy();
  });

  it("says when the Mac's Glade doesn't answer", async () => {
    setup(new TypeError("Failed to fetch"));
    expect(await screen.findByText("Couldn't reach the Mac.")).toBeTruthy();
  });

  it("follows the environment's local_models pushes", async () => {
    setup();
    await screen.findByText("Loading…");
    const loaded = { ...STATE, fetchedAt: 9, models: STATE.models.map((m) => (m.id === "gemma" ? { ...m, status: "loaded" as const } : m)) };
    act(() => handleServerMessage({ type: "local_models", state: loaded }, "studio"));
    expect(within(row("gemma")).getByText("Loaded")).toBeTruthy();
    expect(screen.queryByText("Loading…")).toBeNull();
    // Another Mac's push doesn't touch this one.
    act(() => handleServerMessage({ type: "local_models", state: makeLocalModelsState([]) }));
    expect(row("gemma")).toBeTruthy();
  });
});

describe("LocalModelsPanel: something else answers", () => {
  beforeEach(() => {
    localModels.value = new Map();
  });
  it("treats an error as unusable even when the address answered", async () => {
    setup(makeLocalModelsState([], { reachable: true, error: "http://127.0.0.1:8080 doesn't look like llama-server" }));
    expect(await screen.findByText("http://127.0.0.1:8080 doesn't look like llama-server")).toBeTruthy();
    expect(screen.getByText("Start llama-server in router mode:")).toBeTruthy();
    expect(screen.queryByText(/Loaded .* of/)).toBeNull();
  });
});
