/**
 * The "Remote access" master switch (I-132): Settings → Remote Access, off by default. Off = no
 * remote environments (their sockets closed, items hidden, nothing deleted) and, on a Mac, no
 * hosting either (the server stops serving and cuts paired devices off; it remembers the host
 * switch and restores it when this goes back on).
 *
 * Where it's stored depends on the client, behind {@link MasterBackend}:
 * - **With a local server** (the Mac app, `pnpm dev`): on that server (`meta.remote_master`, read
 *   through `GET /api/auth/remote` = `hostRemote`), so every window on this Mac agrees. This
 *   device caches the last value to start remote connections without waiting.
 * - **Without one** (the phone app, F-022): on the device (localStorage for now).
 *
 * Migration: the old per-device "Connect to other Glade environments" switch (`glade.remoteAccess`)
 * turns the master on once if it was on; the server already migrated its host switch.
 *
 * Portable client core (F-022): no layout or desktop assumptions.
 */
import { effect, signal } from "@preact/signals";
import { hostAuth } from "@/lib/api-auth";
import { hostRemote, loadHostRemote } from "./remote-host";

const CACHE_KEY = "glade.remoteMaster";
/** The pre-I-132 client switch ("Connect to other Glade environments"). */
export const LEGACY_REMOTE_ACCESS_KEY = "glade.remoteAccess";

function readStored(key: string): boolean | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw) === true;
  } catch {
    return null;
  }
}
function writeCache(on: boolean): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(on));
  } catch {
    /* storage unavailable */
  }
}
function dropLegacy(): void {
  try {
    localStorage.removeItem(LEGACY_REMOTE_ACCESS_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** The master switch. Starts from this device's cached value (or the legacy switch). */
export const remoteMaster = signal<boolean>(readStored(CACHE_KEY) ?? readStored(LEGACY_REMOTE_ACCESS_KEY) ?? false);
/** Why the last change failed, until the next one. */
export const remoteMasterError = signal<string | null>(null);

/** Where the switch lives (see the header comment). */
export interface MasterBackend {
  /** The stored value; `null` = unknown (older server): keep the device's. */
  load(): Promise<boolean | null>;
  save(on: boolean): Promise<void>;
}

/** On the device only (phone, or a page without a local server). */
const deviceBackend: MasterBackend = {
  load: async () => readStored(CACHE_KEY),
  save: async (on) => writeCache(on),
};

/** On the local server; `hostRemote` carries the answer (the effect below mirrors it). */
const serverBackend: MasterBackend = {
  load: async () => {
    await loadHostRemote();
    return typeof hostRemote.value?.master === "boolean" ? hostRemote.value.master : null;
  },
  save: async (on) => {
    const state = await hostAuth.setMaster(on);
    // Older servers ignore `master` (no field in the answer): the device value stands.
    if (state && typeof state.enabled === "boolean" && typeof state.master === "boolean") hostRemote.value = { ...hostRemote.value, ...state };
    else writeCache(on);
  },
};

let backend: MasterBackend = deviceBackend;
let stopMirror: (() => void) | null = null;

/**
 * Keep the switch on the page's own server (call when there is one). Mirrors the server's value
 * whenever `hostRemote` is (re)loaded, e.g. by Settings' polling or another window's change.
 */
export function useServerMaster(): void {
  backend = serverBackend;
  stopMirror?.();
  stopMirror = effect(() => {
    const master = hostRemote.value?.master;
    if (typeof master !== "boolean") return;
    if (remoteMaster.peek() !== master) remoteMaster.value = master;
    writeCache(master);
  });
}

/** Read the stored value (at startup, on focus); migrates the legacy client switch once. */
export async function loadRemoteMaster(): Promise<void> {
  const stored = await backend.load().catch(() => null);
  if (stored === null) return;
  remoteMaster.value = stored;
  if (backend === serverBackend) {
    const legacy = readStored(LEGACY_REMOTE_ACCESS_KEY);
    dropLegacy();
    if (legacy === true && !stored) await setRemoteMaster(true);
  }
}

/** Turn the master switch on or off (optimistic; reverted with an error when it fails). */
export async function setRemoteMaster(on: boolean): Promise<void> {
  const before = remoteMaster.value;
  remoteMaster.value = on;
  remoteMasterError.value = null;
  try {
    await backend.save(on);
  } catch (err) {
    remoteMaster.value = before;
    remoteMasterError.value = (err as Error).message;
  }
}

/** Tests: back to the device backend. */
export function resetRemoteMaster(value = false): void {
  stopMirror?.();
  stopMirror = null;
  backend = deviceBackend;
  remoteMaster.value = value;
  remoteMasterError.value = null;
}
