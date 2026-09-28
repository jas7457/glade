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
  /**
   * The host last refused with "remote access is off" (socket closed 4403 or 403
   * `remote_disabled`, I-132). Kept until it answers again, so the status stays "Remote access
   * turned off on <Mac>" even when it becomes unreachable (its Tailscale Serve was removed).
   */
  remoteDisabled?: boolean;
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

/** Remote environments this device connects to while remote access (the I-132 master switch) is on. */
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

/** Remember (or forget) that the host refused with "remote access is off" (I-132). */
export function setRemoteDisabled(id: string, on: boolean): void {
  const entry = savedEnvironments.value.find((e) => e.id === id);
  if (!entry || !!entry.remoteDisabled === on) return;
  const { remoteDisabled: _, ...rest } = entry;
  upsertSavedEnvironment(on ? { ...rest, remoteDisabled: true } : rest);
}

/** The device token for an environment (null: not paired). */
export function tokenFor(envId: string): string | null {
  return savedEnvironments.value.find((e) => e.id === envId)?.token ?? null;
}

/** Tests: re-read storage. */
export function reloadSavedEnvironments(): void {
  savedEnvironments.value = storage.read();
}
