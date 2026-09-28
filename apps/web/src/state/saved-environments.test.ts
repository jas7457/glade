/**
 * I-134: device tokens live in the secret store (Keychain in the Mac app), not in the saved
 * list: loading at startup, writing on pair / Pair Again, deleting on Remove, and the one-time
 * move out of localStorage (a failing store keeps the old token where it was).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localStorageSecretStore, type SecretStore } from "@/lib/secret-store";
import { connectionFor } from "./env-registry";
import { remoteAccessEnabled, resetEnvironments, startEnvironments } from "./environments";
import { resetRemoteMaster } from "./remote-master";
import {
  flushSecretWrites,
  loadSavedEnvironments,
  reloadSavedEnvironments,
  removeSavedEnvironment,
  saveEnvironments,
  savedEnvironments,
  setSecretStore,
  tokenFor,
  upsertSavedEnvironment,
} from "./saved-environments";

const KEY = "glade.environments";
const studio = { id: "ENV-B", name: "Studio", urls: ["http://127.0.0.1:5418"] };

/** An in-memory store; `failing` makes set/get reject. */
function memoryStore(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const state = { failing: false };
  const fail = () => {
    if (state.failing) throw new Error("keychain locked");
  };
  const store: SecretStore = {
    get: vi.fn(async (key: string) => (fail(), items.get(key) ?? null)),
    set: vi.fn(async (key: string, value: string) => {
      fail();
      items.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      fail();
      items.delete(key);
    }),
  };
  return { store, items, state };
}

const listed = () => JSON.parse(localStorage.getItem(KEY) ?? "[]") as Array<Record<string, unknown>>;

beforeEach(() => {
  localStorage.clear();
  reloadSavedEnvironments();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await flushSecretWrites();
  setSecretStore(localStorageSecretStore);
  vi.restoreAllMocks();
});

describe("saved environments and the secret store", () => {
  it("pairing writes the token to the store only; Pair Again overwrites it; Remove deletes it", async () => {
    const { store, items } = memoryStore();
    setSecretStore(store);
    upsertSavedEnvironment({ ...studio, token: "T1", deviceId: "d1" });
    expect(tokenFor("ENV-B")).toBe("T1");
    expect(listed()).toEqual([{ ...studio, deviceId: "d1" }]);
    await flushSecretWrites();
    expect(items.get("env:ENV-B")).toBe("T1");

    upsertSavedEnvironment({ ...studio, token: "T2", deviceId: "d2" });
    await flushSecretWrites();
    expect(items.get("env:ENV-B")).toBe("T2");

    // Other changes (e.g. remembering "remote access off") don't touch the store.
    vi.mocked(store.set).mockClear();
    upsertSavedEnvironment({ ...studio, token: "T2", deviceId: "d2", remoteDisabled: true });
    await flushSecretWrites();
    expect(store.set).not.toHaveBeenCalled();

    removeSavedEnvironment("ENV-B");
    await flushSecretWrites();
    expect(items.has("env:ENV-B")).toBe(false);
    expect(listed()).toEqual([]);
  });

  it("loads tokens from the store at startup", async () => {
    localStorage.setItem(KEY, JSON.stringify([studio, { id: "ENV-C", name: "Air", urls: ["http://air"] }]));
    reloadSavedEnvironments();
    const { store } = memoryStore({ "env:ENV-B": "SECRET" });
    setSecretStore(store);
    await loadSavedEnvironments();
    expect(tokenFor("ENV-B")).toBe("SECRET");
    expect(tokenFor("ENV-C")).toBeNull();
    expect(listed().every((e) => !("token" in e))).toBe(true);
  });

  it("a store that can't be read leaves the environment unpaired (nothing lost)", async () => {
    localStorage.setItem(KEY, JSON.stringify([studio]));
    reloadSavedEnvironments();
    const { store, items, state } = memoryStore({ "env:ENV-B": "SECRET" });
    state.failing = true;
    setSecretStore(store);
    await loadSavedEnvironments();
    expect(tokenFor("ENV-B")).toBeNull();
    expect(items.get("env:ENV-B")).toBe("SECRET");
  });

  it("moves tokens out of localStorage once the store has them", async () => {
    localStorage.setItem(KEY, JSON.stringify([{ ...studio, token: "OLD" }]));
    reloadSavedEnvironments();
    const { store, items } = memoryStore();
    setSecretStore(store);
    // A save before the move keeps the old token in the list.
    upsertSavedEnvironment({ ...studio, token: "OLD", remoteDisabled: true });
    expect(listed()[0]!.token).toBe("OLD");
    vi.mocked(store.set).mockClear();

    await loadSavedEnvironments();
    expect(store.set).toHaveBeenCalledWith("env:ENV-B", "OLD");
    expect(items.get("env:ENV-B")).toBe("OLD");
    expect(listed()).toEqual([{ ...studio, remoteDisabled: true }]);
    expect(tokenFor("ENV-B")).toBe("OLD");

    // Next start: read from the store, nothing left to move.
    reloadSavedEnvironments();
    vi.mocked(store.set).mockClear();
    await loadSavedEnvironments();
    expect(store.set).not.toHaveBeenCalled();
    expect(tokenFor("ENV-B")).toBe("OLD");
  });

  it("keeps the old token in localStorage when the store write fails, and retries next start", async () => {
    localStorage.setItem(KEY, JSON.stringify([{ ...studio, token: "OLD" }]));
    reloadSavedEnvironments();
    const { store, items, state } = memoryStore();
    state.failing = true;
    setSecretStore(store);
    await loadSavedEnvironments();
    expect(tokenFor("ENV-B")).toBe("OLD");
    expect(listed()[0]!.token).toBe("OLD");

    state.failing = false;
    reloadSavedEnvironments();
    await loadSavedEnvironments();
    expect(items.get("env:ENV-B")).toBe("OLD");
    expect(listed()[0]!.token).toBeUndefined();
  });

  it("a new token the store refuses stays in localStorage (not lost)", async () => {
    const { store, state } = memoryStore();
    state.failing = true;
    setSecretStore(store);
    upsertSavedEnvironment({ ...studio, token: "T1" });
    await flushSecretWrites();
    expect(listed()[0]!.token).toBe("T1");
    // Removing it clears both.
    state.failing = false;
    removeSavedEnvironment("ENV-B");
    await flushSecretWrites();
    expect(listed()).toEqual([]);
  });
});

describe("startup", () => {
  afterEach(() => {
    resetEnvironments();
    resetRemoteMaster();
    vi.unstubAllGlobals();
  });

  it("remote connections start with the token from the store", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    saveEnvironments([studio]);
    const { store } = memoryStore({ "env:ENV-B": "SECRET" });
    setSecretStore(store);
    remoteAccessEnabled.value = true;
    await startEnvironments({ localBaseUrl: null });
    expect(savedEnvironments.value[0]!.token).toBe("SECRET");
    expect((connectionFor("ENV-B") as { token?: string | null } | undefined)?.token).toBe("SECRET");
  });
});
