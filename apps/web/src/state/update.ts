/**
 * Update Now (I-154): the local server's update job (`/api/version/update`, pushed as `update` on
 * the local socket) and restarting into the new version afterwards.
 *
 * Restarting quits Glade completely, which stops the chats this server is running, so when any are
 * working the page asks: "Restart when chats finish" (waits until none are, then restarts) or
 * "Restart now". The Mac shell does the restart (`relaunchApp`, lib/desktop.ts).
 */
import { computed, effect, signal, type ReadonlySignal } from "@preact/signals";
import type { ServerMessage, SessionSummary, UpdateJobStatus } from "@glade/protocol";
import { request } from "@/lib/api";
import { isDesktop, relaunchApp } from "@/lib/desktop";
import { socket as localSocket, type Socket } from "@/lib/socket";
import { isLocalEnvironment } from "./env-registry";
import { sessions } from "./store";

/** `null` until loaded, or on servers without Update Now. */
export const updateJob = signal<UpdateJobStatus | null>(null);
/** The last start/cancel/restart failed. */
export const updateActionError = signal<string | null>(null);
/** Waiting for the running chats to finish before restarting. */
export const restartWaiting = signal(false);

function isJob(value: unknown): value is UpdateJobStatus {
  return !!value && typeof value === "object" && "state" in value && Array.isArray((value as UpdateJobStatus).steps);
}

export async function loadUpdateJob(): Promise<void> {
  try {
    const status = await request<UpdateJobStatus>("GET", "/version/update");
    if (isJob(status)) updateJob.value = status;
  } catch {
    // older server, or not the owner: no Update Now
  }
}

export function receiveUpdateMessage(message: ServerMessage): void {
  if (message.type === "batch") {
    for (const m of message.messages) receiveUpdateMessage(m);
    return;
  }
  if (message.type === "update") updateJob.value = message.update;
}

/** Load and follow pushes while mounted (catches up on every reconnect). Returns a stop function. */
export function watchUpdateJob(socket: Socket = localSocket): () => void {
  const offs = [socket.onMessage(receiveUpdateMessage), socket.onOpen(() => void loadUpdateJob())];
  void loadUpdateJob();
  return () => offs.forEach((off) => off());
}

async function jobAction(path: string): Promise<void> {
  updateActionError.value = null;
  try {
    const status = await request<UpdateJobStatus>("POST", path);
    if (isJob(status)) updateJob.value = status;
  } catch (err) {
    updateActionError.value = (err as Error).message;
  }
}

export const startUpdate = () => jobAction("/version/update");
export const cancelUpdate = () => jobAction("/version/update/cancel");

// --- Restarting ------------------------------------------------------------------------------

/**
 * Chats this server is running (`working`/`blocked`, not `activeElsewhere`): restarting stops
 * them. Sessions of other environments don't count (`isLocal` says which are this server's).
 */
export function busyLocalChats(list: readonly SessionSummary[], isLocal: (envId: string | undefined) => boolean): number {
  const busy = new Set<string>();
  for (const s of list) {
    if ((s.status === "working" || s.status === "blocked") && !s.activeElsewhere && isLocal(s.environmentId)) busy.add(s.workspaceId);
  }
  return busy.size;
}

export const busyChats = computed(() => busyLocalChats(sessions.value, (id) => !id || isLocalEnvironment(id)));

/** What "Restart Glade" does: restart at once when nothing runs, else ask (when chats finish / now). */
export function restartChoice(busy: number): "restart" | "ask" {
  return busy > 0 ? "ask" : "restart";
}

/**
 * Calls `then` once `busy` reaches 0 (at once if it already is). Returns a cancel function.
 */
export function whenIdle(busy: ReadonlySignal<number>, then: () => void): () => void {
  let fired = false;
  let dispose: (() => void) | null = null;
  dispose = effect(() => {
    if (fired || busy.value > 0) return;
    fired = true;
    // Run outside the effect (it may navigate/quit).
    queueMicrotask(then);
    dispose?.();
  });
  if (fired) dispose();
  return () => dispose?.();
}

/** The current route, to reopen after the restart. */
function currentRoute(): string {
  return typeof window === "undefined" ? "/" : window.location.pathname + window.location.search;
}

/** Restart now (the page already asked about running chats). */
export async function restartNow(relaunch: (route: string) => Promise<void> = relaunchApp): Promise<void> {
  updateActionError.value = null;
  try {
    await relaunch(currentRoute());
  } catch (err) {
    restartWaiting.value = false;
    updateActionError.value = (err as Error).message || String(err);
  }
}

let cancelWait: (() => void) | null = null;

/** "Restart when chats finish": wait until no chat is running here, then restart. */
export function restartWhenIdle(busy: ReadonlySignal<number> = busyChats, relaunch?: (route: string) => Promise<void>): void {
  cancelWait?.();
  restartWaiting.value = true;
  cancelWait = whenIdle(busy, () => {
    cancelWait = null;
    if (!restartWaiting.value) return;
    void restartNow(relaunch);
  });
}

export function cancelRestartWait(): void {
  cancelWait?.();
  cancelWait = null;
  restartWaiting.value = false;
}

/** Update Now can run here: the Mac app on a server that offers it. */
export function canUpdateHere(job: UpdateJobStatus | null): boolean {
  return !!job?.available && isDesktop();
}
