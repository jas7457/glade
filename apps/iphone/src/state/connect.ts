/**
 * Pairing this iPhone with a Mac (I-164; the flow is the web core's `state/pairing.ts`): from a
 * pasted/scanned link or a code + address. The iPhone sends its own stable device id
 * (`lib/secrets.ts`) as `clientEnvironmentId` and "phone" as its kind, so the Mac's Allow prompt
 * and Connections list show a phone.
 */
import { signal } from "@preact/signals";
import { parsePairInput } from "@glade/app-core/lib/pairing-link";
import { runPairing, type PairState } from "@glade/app-core/state/pairing";
import { HTTPS_ONLY_MESSAGE, allowedAddresses } from "~/lib/address-policy";
import { deviceId } from "~/lib/secrets";

/** The running (or last) pairing attempt; null = none. */
export const pairState = signal<PairState | null>(null);

let controller: AbortController | null = null;

/** Name offered to the Mac (iOS doesn't give apps the device's own name). */
export const IPHONE_DEVICE_NAME = "iPhone";

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
  return runPairing({ ...parsed.target, urls }, {
    deviceName: IPHONE_DEVICE_NAME,
    deviceKind: "phone",
    clientEnvironmentId,
    signal: mine.signal,
    onState: (s) => {
      if (controller === mine) pairState.value = s;
    },
  });
}

export function cancelPairing(): void {
  controller?.abort();
  controller = null;
  pairState.value = null;
}
