import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv, resetEnvironmentsForTest, useEnvironments } from "@glade/app-core/test/env-fixtures";
import { GiB, makeLocalModel, makeLocalModelsState } from "@glade/app-core/test/local-models-fixtures";
import {
  backendLine,
  formatContext,
  isLocalModelPending,
  loadLocalModel,
  loadWarning,
  loadedCount,
  localModels,
  localModelsFetchError,
  localModelsOf,
  memoryUse,
  refreshLocalModels,
  unloadLocalModel,
  unloadWarning,
  usedByLabel,
} from "./local-models";
import { handleServerMessage } from "./store";
import { toasts } from "./toasts";

beforeEach(() => {
  localModels.value = new Map();
  localModelsFetchError.value = new Map();
  toasts.value = [];
});
afterEach(() => resetEnvironmentsForTest());

describe("local_models push", () => {
  it("keeps one state per environment: untagged/local under this Mac, others by id", () => {
    useEnvironments(fakeEnv({ id: "studio" }));
    const here = makeLocalModelsState([makeLocalModel("a")]);
    const studio = makeLocalModelsState([makeLocalModel("b", { status: "loaded" })]);
    handleServerMessage({ type: "local_models", state: here });
    handleServerMessage({ type: "local_models", state: studio }, "studio");
    expect(localModelsOf(null)).toBe(here);
    expect(localModelsOf("local-env")).toBe(here);
    expect(localModelsOf("studio")).toBe(studio);
    expect(loadedCount(localModelsOf("studio"))).toBe(1);
  });
});

describe("actions", () => {
  it("load shows loading right away, then takes the server's answer", async () => {
    const answer = makeLocalModelsState([makeLocalModel("a", { status: "loading" })], { fetchedAt: 2 });
    let resolve!: (s: typeof answer) => void;
    const loadLocalModelApi = vi.fn(() => new Promise<typeof answer>((r) => (resolve = r)));
    useEnvironments(fakeEnv({ id: "studio", api: { loadLocalModel: loadLocalModelApi } }));
    handleServerMessage({ type: "local_models", state: makeLocalModelsState([makeLocalModel("a")]) }, "studio");
    const done = loadLocalModel("studio", "a");
    expect(localModelsOf("studio")!.models[0]!.status).toBe("loading");
    expect(isLocalModelPending("studio", "a")).toBe(true);
    resolve(answer);
    expect(await done).toBe(true);
    expect(loadLocalModelApi).toHaveBeenCalledWith("a", undefined);
    expect(localModelsOf("studio")).toBe(answer);
    expect(isLocalModelPending("studio", "a")).toBe(false);
  });

  it("a failed load puts the old status back and says why", async () => {
    const err = Object.assign(new Error("llama-server isn't running at http://127.0.0.1:8080"), { status: 502 });
    useEnvironments(fakeEnv({ id: "studio", api: { loadLocalModel: () => Promise.reject(err) } }));
    handleServerMessage({ type: "local_models", state: makeLocalModelsState([makeLocalModel("a", { name: "Qwen" })]) }, "studio");
    expect(await loadLocalModel("studio", "a")).toBe(false);
    expect(localModelsOf("studio")!.models[0]!.status).toBe("unloaded");
    expect(toasts.value[0]).toMatchObject({ level: "error", title: "Couldn't load Qwen", message: err.message });
  });

  it("unload calls the environment's API", async () => {
    const after = makeLocalModelsState([makeLocalModel("a")]);
    const unload = vi.fn(async () => after);
    useEnvironments(fakeEnv({ id: "studio", api: { unloadLocalModel: unload } }));
    expect(await unloadLocalModel("studio", "a")).toBe(true);
    expect(unload).toHaveBeenCalledWith("a");
    expect(localModelsOf("studio")).toBe(after);
  });

  it("refresh asks the model server now; an old Glade without the API gets a plain message", async () => {
    const get = vi.fn(async () => makeLocalModelsState([]));
    useEnvironments(fakeEnv({ id: "studio", api: { getLocalModels: get } }), fakeEnv({ id: "old", api: { getLocalModels: () => Promise.reject(Object.assign(new Error("Not Found"), { status: 404 })) } }));
    await refreshLocalModels("studio");
    expect(get).toHaveBeenCalledWith(true);
    expect(localModelsOf("studio")).not.toBeNull();
    await refreshLocalModels("old");
    expect(localModelsFetchError.value.get("old")).toMatch(/doesn't support local models/);
  });
});

describe("wording", () => {
  it("memory line, context, backend, used by", () => {
    const state = makeLocalModelsState([makeLocalModel("a", { status: "loaded", sizeBytes: 19 * GiB }), makeLocalModel("b", { sizeBytes: 50 * GiB })]);
    expect(memoryUse(state).label).toBe("Loaded 19.0 GB of ~96 GB");
    expect(formatContext(32768)).toBe("32k context");
    expect(formatContext(null)).toBeNull();
    expect(backendLine(state)).toBe("llama-server · 127.0.0.1:8080");
    expect(usedByLabel({ usedBy: { chats: 2, working: 0 } })).toBe("Used by 2 chats");
    expect(usedByLabel({ usedBy: { chats: 0, working: 0 } })).toBeNull();
  });

  it("asks before unloading a model chats use", () => {
    expect(unloadWarning({ name: "Q", usedBy: { chats: 0, working: 0 } })).toBeNull();
    expect(unloadWarning({ name: "Q", usedBy: { chats: 2, working: 1 } })).toMatchObject({ title: "Unload Q?", message: "1 chat is working with it." });
    expect(unloadWarning({ name: "Q", usedBy: { chats: 2, working: 0 } })!.message).toMatch(/^2 chats use it\./);
  });

  it("warns when a load may not fit the GPU budget", () => {
    const state = makeLocalModelsState([makeLocalModel("a", { status: "loaded", sizeBytes: 36.9 * GiB })]);
    expect(loadWarning(state, { name: "Small", sizeBytes: 10 * GiB })).toBeNull();
    expect(loadWarning(state, { name: "Big", sizeBytes: 63 * GiB })!.message).toBe("This may not fit: 63.0 GB more with 36.9 GB loaded of ~96 GB. Unload a model first?");
    expect(loadWarning(state, { name: "Unknown", sizeBytes: null })).toBeNull();
  });
});
