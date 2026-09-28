/**
 * This device's list of remote environments and their device tokens (I-123, I-126).
 *
 * The one place credentials are stored. For now that's `localStorage` (the web UI and the Mac
 * app's web view). Keep every read and write of tokens behind this module: the Mac app will
 * move them to the Keychain and the phone app (F-022) to its secure storage, by swapping the
 * `storage` backend below without touching callers.
 *
 * Portable client core (F-022): no layout or desktop assumptions.
 */
import { signal } from "@preact/signals";

/** A remote environment this device knows (saved when paired). */
export interface SavedEnvironment {
  id: string;
  name: string;
  /** Addresses to reach it (its origin, e.g. `http://192.168.1.5:4327`), preferred first. */
  urls: string[];
  /** Device token from pairing (I-125); missing for entries saved before pairing existed. */
  token?: string;
  /** Id of this device on the host (from the pair answer). */
  deviceId?: string;
}

const KEY_SAVED = "glade.environments";

/** Storage backend (swap for the Keychain / secure storage later). */
interface CredentialStorage {
  read(): SavedEnvironment[];
  write(list: SavedEnvironment[]): void;
}

const localStorageBackend: CredentialStorage = {
  read() {
    try {
      const raw = localStorage.getItem(KEY_SAVED);
      const list = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(list) ? (list as SavedEnvironment[]).filter((e) => e && typeof e.id === "string" && Array.isArray(e.urls)) : [];
    } catch {
      return [];
    }
  },
  write(list) {
    try {
      localStorage.setItem(KEY_SAVED, JSON.stringify(list));
    } catch {
      /* storage unavailable */
    }
  },
};

const storage: CredentialStorage = localStorageBackend;

/** Remote environments this device connects to while "Connect to other environments" is on. */
export const savedEnvironments = signal<SavedEnvironment[]>(storage.read());

export function saveEnvironments(list: SavedEnvironment[]): void {
  savedEnvironments.value = list;
  storage.write(list);
}

/** Add or replace (by id) one environment, keeping its place in the list. */
export function upsertSavedEnvironment(entry: SavedEnvironment): void {
  const list = savedEnvironments.value;
  const index = list.findIndex((e) => e.id === entry.id);
  saveEnvironments(index < 0 ? [...list, entry] : list.map((e, i) => (i === index ? entry : e)));
}

export function removeSavedEnvironment(id: string): void {
  saveEnvironments(savedEnvironments.value.filter((e) => e.id !== id));
}

/** The device token for an environment (null: not paired). */
export function tokenFor(envId: string): string | null {
  return savedEnvironments.value.find((e) => e.id === envId)?.token ?? null;
}

/** Tests: re-read storage. */
export function reloadSavedEnvironments(): void {
  savedEnvironments.value = storage.read();
}
