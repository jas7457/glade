/** loadModels' error toasts: none for a remote environment that's just unreachable (I-164). */
import { afterEach, describe, expect, it } from "vitest";
import { signal } from "@preact/signals";
import { connections, type EnvHandle } from "./env-registry";
import { loadModels } from "./store";
import { toasts } from "./toasts";

function env(id: string, isLocal: boolean, listModels: () => Promise<never>): EnvHandle {
  const shell = { settings: signal({}), models: signal([]), harnessDefaults: signal(null), harnesses: signal(null), initialized: signal(true), initError: signal(null) };
  return { id, isLocal, api: { listModels }, request: async () => ({}), shell } as unknown as EnvHandle;
}

afterEach(() => {
  connections.value = [];
  toasts.value = [];
});

describe("loadModels errors", () => {
  it("stays quiet when a remote Mac can't be reached", async () => {
    connections.value = [env("mac", false, () => Promise.reject(new TypeError("Load failed")))];
    await loadModels(false, "mac");
    expect(toasts.value).toHaveLength(0);
  });

  it("still reports a remote server error and any local failure", async () => {
    connections.value = [
      env("mac", false, () => Promise.reject(Object.assign(new Error("boom"), { status: 500 }))),
      env("here", true, () => Promise.reject(new TypeError("Load failed"))),
    ];
    await loadModels(false, "mac");
    await loadModels(false, "here");
    expect(toasts.value.map((t) => t.message)).toEqual(["Could not load models: boom", "Could not load models: Load failed"]);
  });
});
