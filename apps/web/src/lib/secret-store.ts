/**
 * Where this device keeps secrets (I-134): today the device tokens of paired environments,
 * under keys `env:<environmentId>`.
 *
 * - Mac app: the macOS Keychain, through the shell's `secret_get` / `secret_set` /
 *   `secret_delete` commands (apps/desktop/src-tauri/src/secrets.rs; service = the app
 *   identifier, account = the key; only `env:` keys are accepted).
 * - Plain browser (`pnpm dev`, the web UI): `localStorage`. Browsers have no secure storage a
 *   page can use, so this is no better than before I-134; it only exists so the web UI keeps
 *   working. Don't rely on it for anything that needs protecting.
 * - The iPhone app (F-022) plugs its own secure storage in via `setSecretStore`
 *   (state/saved-environments.ts).
 *
 * Portable client core (F-022).
 */
import { isDesktop } from "./desktop";

export interface SecretStore {
  /** The stored value, or null when there is none. Rejects when the store can't be read. */
  get(key: string): Promise<string | null>;
  /** Create or overwrite. */
  set(key: string, value: string): Promise<void>;
  /** Remove (no error when missing). */
  delete(key: string): Promise<void>;
}

/** The key for an environment's device token. */
export function envSecretKey(envId: string): string {
  return `env:${envId}`;
}

/** Mac app: the Keychain via Tauri commands (allowed for the main window only). */
export const desktopSecretStore: SecretStore = {
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

const LOCAL_PREFIX = "glade.secret.";

/**
 * Browser fallback: plain `localStorage` (NOT secure, see the header). Used outside the Mac app
 * only, e.g. `pnpm dev` in a browser.
 */
export const localStorageSecretStore: SecretStore = {
  async get(key) {
    return localStorage.getItem(LOCAL_PREFIX + key);
  },
  async set(key, value) {
    localStorage.setItem(LOCAL_PREFIX + key, value);
  },
  async delete(key) {
    localStorage.removeItem(LOCAL_PREFIX + key);
  },
};

/** The store for this platform. */
export function defaultSecretStore(): SecretStore {
  return isDesktop() ? desktopSecretStore : localStorageSecretStore;
}
