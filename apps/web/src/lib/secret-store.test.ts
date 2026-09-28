import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { defaultSecretStore, desktopSecretStore, envSecretKey, localStorageSecretStore } from "./secret-store";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  invoke.mockReset();
  localStorage.clear();
});

describe("secret store (I-134)", () => {
  it("uses the Keychain commands in the Mac app and localStorage in a browser", () => {
    expect(defaultSecretStore()).toBe(localStorageSecretStore);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(defaultSecretStore()).toBe(desktopSecretStore);
  });

  it("desktop: calls secret_get / secret_set / secret_delete", async () => {
    invoke.mockResolvedValueOnce(null).mockResolvedValueOnce("T").mockResolvedValue(undefined);
    const key = envSecretKey("ENV-B");
    expect(key).toBe("env:ENV-B");
    await expect(desktopSecretStore.get(key)).resolves.toBeNull();
    await expect(desktopSecretStore.get(key)).resolves.toBe("T");
    await desktopSecretStore.set(key, "T");
    await desktopSecretStore.delete(key);
    expect(invoke.mock.calls).toEqual([
      ["secret_get", { key }],
      ["secret_get", { key }],
      ["secret_set", { key, value: "T" }],
      ["secret_delete", { key }],
    ]);
  });

  it("browser fallback: localStorage", async () => {
    await localStorageSecretStore.set("env:X", "T");
    await expect(localStorageSecretStore.get("env:X")).resolves.toBe("T");
    await localStorageSecretStore.delete("env:X");
    await expect(localStorageSecretStore.get("env:X")).resolves.toBeNull();
  });
});
