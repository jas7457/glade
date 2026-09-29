/**
 * The client side of pairing (I-126): connect this device to another environment from a pairing
 * link or an address + short code.
 *
 *   parse (lib/pairing-link) → try the urls in order → `GET /api/environment` (the id must match
 *   the link's `e`) → `POST /api/auth/pair` (long-polls until the host user answers)
 *   → paired: save {id, name, urls, token} (state/saved-environments) → the connection starts.
 *
 * Code-free on your own tailnet (I-143, `runTailnetPairing`): the same probe, then
 * `POST /api/auth/pair {mode:"tailnet", clientNonce}` → the host's nonce → this device derives the
 * number (`pairingNumber`) and shows "Check that <host> shows 4729" while `POST /api/auth/pair/wait`
 * long-polls. A refusal (other account, no Tailscale identity, busy, cooldown, sharing off) ends
 * in `needs-code` with a one-line reason: the dialog then asks for the code as before.
 *
 * `runPairing` reports its steps through `onState` so any layout (desktop dialog, the phone app,
 * F-022) can show them; it never touches the DOM.
 *
 * Portable client core (F-022).
 */
import { signal } from "@preact/signals";
import { pairingNumber, type DeviceKind, type EnvironmentInfo, type PairResponse, type TailnetPairRefusal, type TailnetPairStart } from "@glade/protocol";
import { pairRequest, tailnetPairStart, tailnetPairWait } from "@glade/app-core/lib/api-auth";
import { ApiRequestError, apiBaseFromUrl, isRemoteDisabled, requestAt } from "@glade/app-core/lib/api";
import type { PairTarget } from "@glade/app-core/lib/pairing-link";
import { connectionFor, localEnvironmentId } from "./env-registry";
import { savedEnvironments, upsertSavedEnvironment, type SavedEnvironment } from "./saved-environments";

export type PairErrorKind =
  | "unreachable"
  | "wrong-environment"
  | "this-environment"
  | "remote-disabled"
  | "invalid"
  | "rate-limited"
  | "denied"
  | "expired"
  | "timeout"
  | "failed"
  /** Code-free pairing isn't possible with this host (I-143): type its code instead. */
  | "needs-code";

export type PairState =
  | { step: "connecting" }
  /** The host was found; waiting for its user to press Allow. */
  | { step: "waiting"; hostName: string }
  /** Code-free (I-143): waiting for Allow; the host shows the same `number`. */
  | { step: "confirm"; hostName: string; number: string }
  | { step: "paired"; environment: SavedEnvironment }
  | { step: "error"; kind: PairErrorKind; message: string }
  | { step: "cancelled" };

export interface PairOptions {
  /** Sent to the host (its Allow prompt and list): this device's own name, {@link defaultDeviceName} (I-138). */
  deviceName: string;
  deviceKind: DeviceKind;
  /**
   * Sent as `clientEnvironmentId` (I-136). Defaults to the local environment's id; a pure client
   * without one (the iPhone app, I-164) passes its own stable device id.
   */
  clientEnvironmentId?: string;
  onState?: (state: PairState) => void;
  signal?: AbortSignal;
  /** How long to wait for each address's `GET /api/environment` (ms). */
  probeTimeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 6_000;

function clientIdOf(options: PairOptions): { clientEnvironmentId?: string } {
  const id = options.clientEnvironmentId ?? localEnvironmentId.value;
  return id ? { clientEnvironmentId: id } : {};
}

function describeHost(target: PairTarget, info?: EnvironmentInfo | null): string {
  return info?.name || target.name || hostOf(target.urls[0] ?? "") || "the other device";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * First address where a Glade answers `GET /api/environment`, in the order given. `info` is
 * `null` when the host answered but wants a token first (a Glade auth error): it's reachable,
 * and its id is then checked in the pair answer instead.
 */
async function probe(urls: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<{ url: string; info: EnvironmentInfo | null } | null> {
  for (const url of urls) {
    if (signal?.aborted) return null;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort);
    const timer = setTimeout(abort, timeoutMs);
    try {
      const info = await requestAt<EnvironmentInfo>(apiBaseFromUrl(url), "GET", "/environment", undefined, undefined, { signal: controller.signal });
      if (info && typeof info.id === "string" && info.id) return { url, info };
    } catch (err) {
      if (err instanceof ApiRequestError && (err.status === 401 || err.status === 403) && err.code) return { url, info: null };
      /* try the next address */
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return null;
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, "").replace(/\/api$/, "")}`;
  } catch {
    return url;
  }
}

/**
 * Pair with the environment described by `target`. Resolves with the final state (paired,
 * error or cancelled); on success the environment is saved with its token.
 */
export async function runPairing(target: PairTarget, options: PairOptions): Promise<PairState> {
  const { signal, onState } = options;
  const report = (state: PairState): PairState => {
    onState?.(state);
    return state;
  };
  const fail = (kind: PairErrorKind, message: string) => report({ step: "error", kind, message });
  const cancelled = () => report({ step: "cancelled" });

  report({ step: "connecting" });
  const found = await probe(target.urls, signal, options.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
  if (signal?.aborted) return cancelled();
  const hostName = describeHost(target, found?.info);
  if (!found) {
    const where = target.urls.map(hostOf).join(", ");
    return fail("unreachable", `Couldn't reach ${hostName} at ${where}. Check that Glade is running there and that both devices are on the same network.`);
  }
  if (found.info && target.environmentId && found.info.id !== target.environmentId) {
    return fail("wrong-environment", `A different Glade answered at ${hostOf(found.url)} (“${found.info.name}”), not ${hostName}. Nothing was paired.`);
  }
  if (found.info && found.info.id === localEnvironmentId.value) return fail("this-environment", "That's this device. Pair from another one.");

  report({ step: "waiting", hostName });
  let answer: PairResponse;
  try {
    answer = await pairRequest(
      apiBaseFromUrl(found.url),
      {
        grant: target.grant,
        deviceName: options.deviceName.trim() || "Glade",
        deviceKind: options.deviceKind,
        ...clientIdOf(options),
      },
      signal,
    );
  } catch (err) {
    if (signal?.aborted) return cancelled();
    if (isRemoteDisabled(err)) return fail("remote-disabled", `Remote access is off on ${hostName}. Turn on “Let other devices use this device” there first.`);
    if (err instanceof ApiRequestError) {
      if (err.status === 429) return fail("rate-limited", `Too many attempts. Wait a minute, then create a new code on ${hostName}.`);
      if (err.status === 400 || err.status === 401 || err.status === 404 || err.status === 410)
        return fail("invalid", `That code or link isn't valid anymore. Create a new one on ${hostName} (Settings → Remote Access → Share This Device…).`);
      return fail("failed", `Pairing failed: ${err.message}`);
    }
    return fail("unreachable", `Lost the connection to ${hostName} while waiting.`);
  }
  return finishPairing(answer, { target, found, hostName, report, fail, codeFree: false });
}

interface FinishContext {
  target: PairTarget;
  found: { url: string; info: EnvironmentInfo | null };
  hostName: string;
  report: (state: PairState) => PairState;
  fail: (kind: PairErrorKind, message: string) => PairState;
  codeFree: boolean;
}

/** The host's answer → saved environment or an error (shared by both flows). */
function finishPairing(answer: PairResponse, { target, found, hostName, report, fail, codeFree }: FinishContext): PairState {
  switch (answer.status) {
    case "denied":
      return fail("denied", `${hostName} didn't allow this device.`);
    case "expired":
      return fail("expired", codeFree ? `The request to ${hostName} was cancelled. Try again.` : `The code expired. Create a new one on ${hostName}.`);
    case "timeout":
      return fail("timeout", `Nobody answered on ${hostName} in time. Try again and press Allow there.`);
    case "paired": {
      const expected = found.info?.id ?? target.environmentId;
      if ((expected && answer.environmentId !== expected) || answer.environmentId === localEnvironmentId.value)
        return fail("wrong-environment", "The host answered with a different environment id. Nothing was saved.");
      // The address that worked goes first; the link's others stay as fallbacks.
      const urls = [originOf(found.url), ...target.urls.map(originOf).filter((u) => u !== originOf(found.url))];
      // Pairing again keeps this device's own name for it (I-138).
      const alias = savedEnvironments.value.find((e) => e.id === answer.environmentId)?.alias;
      const environment: SavedEnvironment = {
        id: answer.environmentId,
        name: found.info?.name ?? target.name ?? hostName,
        urls,
        token: answer.token,
        deviceId: answer.device.id,
        ...(alias ? { alias } : {}),
      };
      upsertSavedEnvironment(environment);
      return report({ step: "paired", environment });
    }
    default:
      return fail("failed", "The host gave an answer this version doesn't understand.");
  }
}

/** Target of a code-free pairing (I-143): a device found on the tailnet, or Pair Again with one. */
export interface TailnetPairTarget {
  name?: string;
  /** Its `https://<machine>.<tailnet>.ts.net` address. */
  url: string;
  /** Pair Again: the host must be this environment. */
  environmentId?: string;
}

/** Only Tailscale addresses can carry a Tailscale identity (I-143): other addresses go straight to the code. */
export function isTailnetAddress(url: string | undefined): boolean {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "https:" && u.hostname.toLowerCase().endsWith(".ts.net");
  } catch {
    return false;
  }
}

function newClientNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function refusalMessage(reason: TailnetPairRefusal | "remote-disabled" | "rate-limited" | "old-host", hostName: string): string {
  switch (reason) {
    case "other_account":
      return `${hostName} uses a different Tailscale account, so it needs a code.`;
    case "no_identity":
      return `${hostName} can't see your Tailscale account on this connection, so it needs a code.`;
    case "busy":
      return `${hostName} is answering another request. Try again in a moment, or use a code.`;
    case "cooldown":
      return `${hostName} denied a request a moment ago. Try again in a minute, or use a code.`;
    case "unavailable":
      return `${hostName} can't check your Tailscale account right now, so it needs a code.`;
    case "remote-disabled":
      return `${hostName} isn't sharing right now. Turn on “Let other devices use this device” there, then use its code.`;
    case "rate-limited":
      return `Too many attempts. Wait a minute, or use a code from ${hostName}.`;
    case "old-host":
      return `${hostName} runs an older Glade that needs a code.`;
  }
}

/**
 * Code-free pairing on your own tailnet (I-143). Resolves with paired, an error (denied, timeout,
 * …), `needs-code` (fall back to the code field) or cancelled.
 */
export async function runTailnetPairing(target: TailnetPairTarget, options: PairOptions): Promise<PairState> {
  const { signal, onState } = options;
  const report = (state: PairState): PairState => {
    onState?.(state);
    return state;
  };
  const fail = (kind: PairErrorKind, message: string) => report({ step: "error", kind, message });
  const cancelled = () => report({ step: "cancelled" });
  const pairTarget: PairTarget = { urls: [target.url], grant: "", name: target.name ?? null, environmentId: target.environmentId ?? null };

  report({ step: "connecting" });
  const found = await probe([target.url], signal, options.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
  if (signal?.aborted) return cancelled();
  // This device's name for it (a found device's name, or its alias for Pair Again) first.
  const hostName = target.name || describeHost(pairTarget, found?.info);
  if (!found) return fail("unreachable", `Couldn't reach ${hostName} at ${hostOf(target.url)}. Check that Glade is running there and that both devices are on the same network.`);
  if (found.info && target.environmentId && found.info.id !== target.environmentId) {
    return fail("wrong-environment", `A different Glade answered at ${hostOf(found.url)} (“${found.info.name}”), not ${hostName}. Nothing was paired.`);
  }
  if (found.info && found.info.id === localEnvironmentId.value) return fail("this-environment", "That's this device. Pair from another one.");

  const apiBase = apiBaseFromUrl(found.url);
  const clientNonce = newClientNonce();
  let start: TailnetPairStart;
  try {
    start = await tailnetPairStart(
      apiBase,
      {
        mode: "tailnet",
        clientNonce,
        deviceName: options.deviceName.trim() || "Glade",
        deviceKind: options.deviceKind,
        ...clientIdOf(options),
      },
      signal,
    );
  } catch (err) {
    if (signal?.aborted) return cancelled();
    if (isRemoteDisabled(err)) return fail("needs-code", refusalMessage("remote-disabled", hostName));
    if (err instanceof ApiRequestError) {
      if (err.status === 429) return fail("needs-code", refusalMessage("rate-limited", hostName));
      // An older host reads this as a code request without a code.
      if (err.status === 400) return fail("needs-code", refusalMessage("old-host", hostName));
      return fail("failed", `Pairing failed: ${err.message}`);
    }
    return fail("unreachable", `Lost the connection to ${hostName}.`);
  }
  if (start.status === "refused") return fail("needs-code", refusalMessage(start.reason, hostName));
  if (start.status !== "confirm" || typeof start.hostNonce !== "string") return fail("needs-code", refusalMessage("old-host", hostName));

  report({ step: "confirm", hostName, number: pairingNumber(clientNonce, start.hostNonce) });
  let answer: PairResponse;
  try {
    answer = await tailnetPairWait(apiBase, { requestId: start.requestId, clientNonce }, signal);
  } catch (err) {
    if (signal?.aborted) return cancelled();
    if (err instanceof ApiRequestError && err.status === 404) return fail("expired", `The request to ${hostName} is no longer waiting. Try again.`);
    return fail("unreachable", `Lost the connection to ${hostName} while waiting.`);
  }
  if (answer.status === "denied") return fail("denied", `${hostName} didn't allow this device.`);
  if (answer.status === "timeout") return fail("timeout", `Nobody answered on ${hostName} in time. Try again and press Allow there.`);
  return finishPairing(answer, { target: pairTarget, found, hostName, report, fail, codeFree: true });
}

/** This device's name offered to the host ("MacBook Air"): the local environment's name. */
export function defaultDeviceName(): string {
  const local = localEnvironmentId.value ? connectionFor(localEnvironmentId.value) : undefined;
  return local?.info.value?.name ?? local?.name.value ?? "Glade";
}

/** A saved environment that needs pairing again (for the "Pair again" dialog's address). */
export function savedEnvironment(envId: string): SavedEnvironment | undefined {
  return savedEnvironments.value.find((e) => e.id === envId);
}

/**
 * Something asked to open the connect dialog: a `/pair?link=…` deep link, or "Pair again" on an
 * environment that needs it. Settings → Remote Access opens the dialog and clears it.
 */
export const pairDialogRequest = signal<{ link?: string; envId?: string } | null>(null);
