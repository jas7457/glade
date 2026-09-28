/**
 * Host side of remote access (I-125/I-126) for the *local* environment: the "Let other devices use
 * this Mac" switch, pairings waiting for Allow/Deny (pushed as `pairing_pending` on the local
 * socket), and the paired devices list. The UI is `features/environments` (Settings → Remote
 * Access, the app-wide confirm modal).
 */
import { signal } from "@preact/signals";
import type { PairedDevice, PendingPairing, RemoteAccessState, ServerMessage } from "@glade/protocol";
import { hostAuth } from "@/lib/api-auth";
import { socket as localSocket, type Socket } from "@/lib/socket";

/** `GET /api/auth/remote`; `null` until loaded (or on servers without auth). Its `master` is the I-132 master switch (`state/remote-master.ts`). */
export const hostRemote = signal<RemoteAccessState | null>(null);
export const hostRemoteError = signal<string | null>(null);
/** Why the last switch change failed (e.g. Tailscale refused), until the next change. */
export const hostRemoteSwitchError = signal<string | null>(null);
/** Pairings waiting for this Mac's answer, oldest first. */
export const pendingPairings = signal<PendingPairing[]>([]);
/** This window's answers to pairings (the Add Device dialog shows the outcome of its invite). */
export const pairingAnswers = signal<ReadonlyMap<string, boolean>>(new Map());
/** Paired devices; `null` until loaded. */
export const pairedDevices = signal<PairedDevice[] | null>(null);

export async function loadHostRemote(): Promise<void> {
  try {
    const state = await hostAuth.getRemote();
    if (!state || typeof state.enabled !== "boolean") throw new Error("This server doesn't support remote access yet.");
    hostRemote.value = {
      enabled: state.enabled,
      ...(typeof state.master === "boolean" ? { master: state.master } : {}),
      addresses: Array.isArray(state.addresses) ? state.addresses : [],
      ...(state.transport && typeof state.transport === "object" ? { transport: state.transport } : {}),
    };
    hostRemoteError.value = null;
  } catch (err) {
    hostRemoteError.value = (err as Error).message;
  }
}

export async function setHostRemote(enabled: boolean): Promise<void> {
  const previous = hostRemote.value;
  if (previous) hostRemote.value = { ...previous, enabled };
  try {
    hostRemote.value = await hostAuth.setRemote(enabled);
    hostRemoteError.value = null;
    hostRemoteSwitchError.value = null;
  } catch (err) {
    hostRemote.value = previous;
    hostRemoteSwitchError.value = (err as Error).message;
    // The transport's status may have changed (e.g. Tailscale was signed out meanwhile).
    void loadHostRemote();
  }
}

export async function loadDevices(): Promise<void> {
  try {
    const list = await hostAuth.listDevices();
    if (Array.isArray(list)) pairedDevices.value = list;
  } catch {
    /* keep the last list */
  }
}

export async function renameDevice(id: string, name: string): Promise<void> {
  const device = await hostAuth.renameDevice(id, name);
  pairedDevices.value = (pairedDevices.value ?? []).map((d) => (d.id === id ? device : d));
}

export async function revokeDevice(id: string): Promise<void> {
  await hostAuth.revokeDevice(id);
  pairedDevices.value = (pairedDevices.value ?? []).filter((d) => d.id !== id);
}

export async function revokeAllDevices(): Promise<void> {
  await hostAuth.revokeAllDevices();
  pairedDevices.value = [];
}

/** Allow or deny a waiting pairing. It leaves the list at once (the server confirms with a push). */
export async function answerPairing(id: string, allow: boolean): Promise<void> {
  pendingPairings.value = pendingPairings.value.filter((p) => p.id !== id);
  pairingAnswers.value = new Map(pairingAnswers.value).set(id, allow);
  try {
    await hostAuth.answerPending(id, allow);
  } finally {
    if (allow) void loadDevices();
  }
}

function sortPending(list: PendingPairing[]): PendingPairing[] {
  return [...list].sort((a, b) => a.requestedAt - b.requestedAt);
}

/** Apply a pushed message (unwrapping batches). */
export function receiveHostMessage(message: ServerMessage): void {
  if (message.type === "batch") {
    for (const m of message.messages) receiveHostMessage(m);
    return;
  }
  if (message.type !== "pairing_pending") return;
  pushes++;
  const before = pendingPairings.value.length;
  pendingPairings.value = sortPending(message.pending);
  // A pairing was answered (maybe in another window): the devices list may have a new entry.
  if (message.pending.length < before && pairedDevices.value) void loadDevices();
}

let stopWatch: (() => void) | null = null;
/** Counts pushes, so a catch-up answer older than a push doesn't overwrite it. */
let pushes = 0;

/**
 * Listen for `pairing_pending` on the local environment's socket (and catch up on every
 * (re)connect). Call once; returns a stop function.
 */
export function watchHostPairing(socket: Socket = localSocket): () => void {
  stopWatch?.();
  const catchUp = () => {
    const seen = pushes;
    void hostAuth.listPending().then(
      (list) => {
        if (pushes === seen) pendingPairings.value = sortPending(list);
      },
      () => {
        /* older server, or not the owner */
      },
    );
  };
  const offs = [socket.onMessage(receiveHostMessage), socket.onOpen(catchUp)];
  catchUp();
  stopWatch = () => {
    offs.forEach((off) => off());
    stopWatch = null;
  };
  return stopWatch;
}

/** Tests. */
export function resetRemoteHost(): void {
  stopWatch?.();
  hostRemote.value = null;
  hostRemoteError.value = null;
  hostRemoteSwitchError.value = null;
  pendingPairings.value = [];
  pairedDevices.value = null;
  pairingAnswers.value = new Map();
}
