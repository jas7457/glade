/**
 * This device's list of remote environments and their device tokens (I-123, I-126, I-134).
 *
 * Keep every read and write of tokens behind this module.
 * - The list (id, name, addresses, …) is in `localStorage` without tokens.
 * - Tokens live in the platform's secret store (`lib/secret-store.ts`, key `env:<id>`): the
 *   Keychain in the Mac app, `localStorage` in a plain browser, the phone's secure storage
 *   later (F-022, `setSecretStore`). In memory, {@link savedEnvironments} carries them merged in.
 * - {@link loadSavedEnvironments} (startup, before remote connections start) reads them, and
 *   moves tokens still in the old list (before I-134) into the store; each one leaves
 *   `localStorage` only once the store has it. Pairing (again) writes a token, removing an
 *   environment deletes it. If the store can't take a token it stays in `localStorage` (as
 *   before I-134) and the next start tries again.
 *
 * Portable client core (F-022): no layout or desktop assumptions.
 */
import { signal } from "@preact/signals";
import { defaultSecretStore, envSecretKey, type SecretStore } from "@/lib/secret-store";

/** A remote environment this device knows (saved when paired). */
export interface SavedEnvironment {
  id: string;
  name: string;
  /** Addresses to reach it (its origin, e.g. `http://192.168.1.5:4327`), preferred first. */
  urls: string[];
  /**
   * Device token from pairing (I-125); missing for entries saved before pairing existed. In
   * memory only: persisted in the secret store (I-134), not in the list.
   */
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

function readList(): SavedEnvironment[] {
  try {
    const raw = localStorage.getItem(KEY_SAVED);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? (list as SavedEnvironment[]).filter((e) => e && typeof e.id === "string" && Array.isArray(e.urls)) : [];
  } catch {
    return [];
  }
}

const initial = readList();

/**
 * Environments whose token is (still) kept in the `localStorage` list: saved before I-134 and not
 * moved yet, or the secret store refused it.
 */
const tokensInList = new Set(initial.filter((e) => e.token).map((e) => e.id));

/** Write the list; tokens only for {@link tokensInList}. */
function writeList(list: SavedEnvironment[]): void {
  try {
    const plain = list.map(({ token, ...rest }) => (token && tokensInList.has(rest.id) ? { ...rest, token } : rest));
    localStorage.setItem(KEY_SAVED, JSON.stringify(plain));
  } catch {
    /* storage unavailable */
  }
}

let secrets: SecretStore = defaultSecretStore();
/** Secret-store writes run one after another (a Pair Again then a Remove land in order). */
let writes: Promise<void> = Promise.resolve();

/** Plug in another secret store (the phone app, F-022; tests). */
export function setSecretStore(store: SecretStore): void {
  secrets = store;
}

/** Tests: wait for queued secret-store writes. */
export function flushSecretWrites(): Promise<void> {
  return writes;
}

function queue(task: () => Promise<void>): void {
  writes = writes.then(task).catch((err: unknown) => console.error("[glade] secret store:", err));
}

/** Store a token; if the store fails, keep it in the list instead (as before I-134). */
function storeToken(id: string, token: string): void {
  queue(async () => {
    try {
      await secrets.set(envSecretKey(id), token);
    } catch (err) {
      console.error(`[glade] couldn't store the token for ${id}; keeping it in localStorage`, err);
      if (current(id)?.token === token) {
        tokensInList.add(id);
        writeList(savedEnvironments.value);
      }
      return;
    }
    if (tokensInList.delete(id)) writeList(savedEnvironments.value);
  });
}

function deleteToken(id: string): void {
  queue(() => secrets.delete(envSecretKey(id)));
}

const current = (id: string) => savedEnvironments.value.find((e) => e.id === id);

/** Remote environments this device connects to while remote access (the I-132 master switch) is on. */
export const savedEnvironments = signal<SavedEnvironment[]>(initial);

export function saveEnvironments(list: SavedEnvironment[]): void {
  const before = new Map(savedEnvironments.value.map((e) => [e.id, e.token]));
  savedEnvironments.value = list;
  for (const e of list) {
    if (!e.token) {
      if (tokensInList.delete(e.id) || before.get(e.id)) deleteToken(e.id);
    } else if (e.token !== before.get(e.id)) {
      storeToken(e.id, e.token);
    }
  }
  const ids = new Set(list.map((e) => e.id));
  for (const [id, token] of before) {
    if (ids.has(id)) continue;
    tokensInList.delete(id);
    if (token) deleteToken(id);
  }
  writeList(list);
}

/**
 * Startup (before remote connections start): read each environment's token from the secret
 * store, and move tokens still in the `localStorage` list into it (I-134 migration).
 */
export async function loadSavedEnvironments(): Promise<void> {
  const legacy = new Map(readList().flatMap((e) => (e.token ? [[e.id, e.token] as const] : [])));
  const loaded = await Promise.all(
    savedEnvironments.value.map(async ({ id }): Promise<[string, string | undefined]> => {
      const old = legacy.get(id) ?? (tokensInList.has(id) ? current(id)?.token : undefined);
      if (old) {
        try {
          await secrets.set(envSecretKey(id), old);
          tokensInList.delete(id);
        } catch (err) {
          console.error(`[glade] couldn't move the token for ${id} out of localStorage; keeping it there`, err);
          tokensInList.add(id);
        }
        return [id, old];
      }
      try {
        return [id, (await secrets.get(envSecretKey(id))) ?? undefined];
      } catch (err) {
        console.error(`[glade] couldn't read the token for ${id}`, err);
        return [id, undefined];
      }
    }),
  );
  const tokens = new Map(loaded);
  // Entries paired meanwhile keep their new token.
  savedEnvironments.value = savedEnvironments.value.map((e) => {
    const token = tokens.get(e.id);
    return e.token || !token ? e : { ...e, token };
  });
  writeList(savedEnvironments.value);
}

/** Add or replace (by id) one environment, keeping its place in the list. */
export function upsertSavedEnvironment(entry: SavedEnvironment): void {
  const list = savedEnvironments.value;
  const index = list.findIndex((e) => e.id === entry.id);
  saveEnvironments(index < 0 ? [...list, entry] : list.map((e, i) => (i === index ? entry : e)));
}

/** Remove an environment and its token. */
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

/** Tests: forget everything in memory and re-read the list (tokens come with {@link loadSavedEnvironments}). */
export function reloadSavedEnvironments(): void {
  const list = readList();
  tokensInList.clear();
  for (const e of list) if (e.token) tokensInList.add(e.id);
  savedEnvironments.value = list;
}
