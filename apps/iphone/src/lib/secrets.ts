/**
 * The iPhone app's secret storage (I-164, docs/design/iphone-app.md §4.2): device tokens of paired
 * Macs (`env:<id>`) and the iPhone's own device id (`device:id`) live in the iOS Keychain through
 * the shell's `secret_*` commands (src-tauri/src/secrets.rs). Outside the app (Vite in Chrome at
 * phone size) it falls back to the web core's localStorage store, which is NOT secure.
 */
import { localStorageSecretStore, type SecretStore } from "@glade/app-core/lib/secret-store";

/** Inside the Tauri shell (the real app or the simulator). */
export function inShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const keychainSecretStore: SecretStore = {
  async get(key) {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<string | null>("secret_get", { key })) ?? null;
  },
  async set(key, value) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("secret_set", { key, value });
  },
  async delete(key) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("secret_delete", { key });
  },
};

export function iphoneSecretStore(): SecretStore {
  return inShell() ? keychainSecretStore : localStorageSecretStore;
}

const DEVICE_ID_KEY = "device:id";

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `iphone-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

let cached: Promise<string> | null = null;

/**
 * This iPhone's stable id (made on first launch, kept in the Keychain). Sent as
 * `clientEnvironmentId` when pairing so a Mac's Connections list can recognise it (I-136).
 */
export function deviceId(store: SecretStore = iphoneSecretStore()): Promise<string> {
  cached ??= (async () => {
    const existing = await store.get(DEVICE_ID_KEY).catch(() => null);
    if (existing) return existing;
    const id = randomId();
    await store.set(DEVICE_ID_KEY, id).catch(() => {});
    return id;
  })();
  return cached;
}

/** Tests only. */
export function resetDeviceIdCache(): void {
  cached = null;
}
