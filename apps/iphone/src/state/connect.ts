/**
 * Pairing this iPhone with a Mac (I-164; the flow is the web core's `state/pairing.ts`): from a
 * pasted/scanned link or a code + address. The iPhone sends its own stable device id
 * (`lib/secrets.ts`) as `clientEnvironmentId` and "phone" as its kind, so the Mac's Allow prompt
 * and Connections list show a phone.
 *
 * This iPhone's name (I-171): iOS 16+ only tells apps "iPhone", so the user names it here (the
 * Connect screen, Settings); stored on the phone, sent when pairing, and pushed to every paired
 * Mac with `PATCH /api/auth/me` (a device renames only itself). Macs that are down get it the
 * next time they connect (`syncPhoneName`, started at boot).
 */
import { effect, signal } from "@preact/signals";
import { parsePairInput } from "@glade/app-core/lib/pairing-link";
import { connections } from "@glade/app-core/state/env-registry";
import { runPairing, type PairState } from "@glade/app-core/state/pairing";
import { HTTPS_ONLY_MESSAGE, allowedAddresses } from "~/lib/address-policy";
import { deviceId } from "~/lib/secrets";

/** The running (or last) pairing attempt; null = none. */
export const pairState = signal<PairState | null>(null);

let controller: AbortController | null = null;

/** Default name offered to the Mac (iOS doesn't give apps the device's own name). */
export const IPHONE_DEVICE_NAME = "iPhone";
/** Same cap as the server's `MAX_DEVICE_NAME`. */
export const MAX_PHONE_NAME = 100;

const NAME_KEY = "glade.iphone.deviceName";
/** envId → the name that Mac last accepted from this phone. */
const SYNCED_KEY = "glade.iphone.deviceNameSynced";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/** Trimmed, whitespace collapsed, capped; empty → the default. */
export function cleanPhoneName(name: string): string {
  const clean = name.replace(/[\p{Cc}\s]+/gu, " ").trim().slice(0, MAX_PHONE_NAME).trim();
  return clean || IPHONE_DEVICE_NAME;
}

function readName(): string {
  try {
    return cleanPhoneName(localStorage.getItem(NAME_KEY) ?? "");
  } catch {
    return IPHONE_DEVICE_NAME;
  }
}

/** This iPhone's name on your Macs. */
export const phoneName = signal<string>(readName());
const synced = signal<Record<string, string>>(readJson<Record<string, string>>(SYNCED_KEY, {}));

function markSynced(envId: string, name: string): void {
  synced.value = { ...synced.value, [envId]: name };
  write(SYNCED_KEY, JSON.stringify(synced.value));
}

/** Save a new name here; connected Macs get it now (via `syncPhoneName`), the others when they connect. */
export function setPhoneName(name: string): string {
  const clean = cleanPhoneName(name);
  if (clean === phoneName.value) return clean;
  phoneName.value = clean;
  write(NAME_KEY, clean);
  return clean;
}

const inFlight = new Set<string>();

/**
 * Keep every connected Mac's name for this phone equal to `phoneName` (only pushes when it
 * differs from what that Mac last accepted, so a rename on the Mac's side sticks until the phone
 * is renamed again). Call once at boot; returns stop.
 */
export function syncPhoneName(): () => void {
  return effect(() => {
    const name = phoneName.value;
    const done = synced.value;
    for (const c of connections.value) {
      if (c.isLocal || c.status.value !== "live" || done[c.id] === name) continue;
      const key = `${c.id}\n${name}`;
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      // A failure (older Mac without `PATCH /auth/me`, dropped connection) tries again the next
      // time that Mac connects or the name changes.
      c.request<unknown>("PATCH", "/auth/me", { name })
        .then(() => markSynced(c.id, name))
        .catch(() => {})
        .finally(() => inFlight.delete(key));
    }
  });
}

export async function startPairing(linkOrCode: string, address = ""): Promise<PairState> {
  controller?.abort();
  const parsed = parsePairInput(linkOrCode, address);
  if (!parsed.ok) {
    const state: PairState = { step: "error", kind: "invalid", message: parsed.error };
    pairState.value = state;
    return state;
  }
  const urls = allowedAddresses(parsed.target.urls);
  if (urls.length === 0) {
    const state: PairState = { step: "error", kind: "invalid", message: HTTPS_ONLY_MESSAGE };
    pairState.value = state;
    return state;
  }
  const mine = new AbortController();
  controller = mine;
  pairState.value = { step: "connecting" };
  const clientEnvironmentId = await deviceId();
  const deviceName = phoneName.value;
  const result = await runPairing({ ...parsed.target, urls }, {
    deviceName,
    deviceKind: "phone",
    clientEnvironmentId,
    signal: mine.signal,
    onState: (s) => {
      if (controller === mine) pairState.value = s;
    },
  });
  // The Mac already has this name from the pairing request.
  if (result.step === "paired") markSynced(result.environment.id, deviceName);
  return result;
}

export function cancelPairing(): void {
  controller?.abort();
  controller = null;
  pairState.value = null;
}
