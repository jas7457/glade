/**
 * Update Now (I-154): the local server's update job (`/api/version/update`, pushed as `update` on
 * the local socket) and restarting into the new version afterwards.
 *
 * Restarting quits Glade completely, which stops the chats this server is running, so when any are
 * working the page asks: "Restart when chats finish" (waits until none are, then restarts) or
 * "Restart now". The Mac shell does the restart (`relaunchApp`, lib/desktop.ts).
 *
 * I-197: no second click. Once a newer build sits in the app's bundle (`VersionStatus.installed`,
 * pushed as `version`; Update Now or `pnpm tauri:install` from anywhere), the Mac app's own window
 * restarts right away when no chat of this server is working, else waits until they all finish
 * ({@link startAutoRestart}, registered at app start; the wait shows `RestartNotice`). Cancel
 * stops it for that build; a newer build starts it again.
 */
import { computed, effect, signal, untracked, type ReadonlySignal } from "@preact/signals";
import type { BuildInfo, ServerMessage, SessionSummary, UpdateJobStatus, VersionStatus } from "@glade/protocol";
import { saveDraftsForRestart } from "@glade/app-core/features/chat/drafts";
import { request } from "@glade/app-core/lib/api";
import { isDesktop, relaunchApp } from "@glade/app-core/lib/desktop";
import { socket as localSocket, type Socket } from "@glade/app-core/lib/socket";
import { isLocalEnvironment } from "@glade/app-core/state/env-registry";
import { initError, initialized, sessions } from "@glade/app-core/state/store";
import { notify } from "@glade/app-core/state/toasts";
import { loadVersion, versionStatus } from "@glade/app-core/state/version";

/** `null` until loaded, or on servers without Update Now. */
export const updateJob = signal<UpdateJobStatus | null>(null);
/** The last start/cancel/restart failed. */
export const updateActionError = signal<string | null>(null);
/** Waiting for the running chats to finish before restarting. */
export const restartWaiting = signal(false);
/** The restart was asked for (Glade is quitting and reopening); cleared when it failed. */
export const restarting = signal(false);

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
  cancelWait?.();
  cancelWait = null;
  restartWaiting.value = false;
  restarting.value = true;
  try {
    // Composer drafts are in memory: keep them for the next launch (I-197).
    saveDraftsForRestart();
    await relaunch(currentRoute());
  } catch (err) {
    restarting.value = false;
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

// --- Restarting on its own (I-197) -----------------------------------------------------------

/** Which installed build a decision was made for (`commit@builtAt`). */
export function installKey(build: BuildInfo): string {
  return `${build.commit}@${build.builtAt}`;
}

/** The installed build the last automatic restart (or wait) was started for. */
let handledInstall: string | null = null;

/**
 * Restart into `installed` on its own, once per build: right away when no chat runs here, else
 * when they all finish. Returns what it did (`none`: already handled for this build).
 */
export function autoRestartFor(
  installed: BuildInfo,
  busy: ReadonlySignal<number> = busyChats,
  relaunch?: (route: string) => Promise<void>,
): "none" | "restart" | "wait" {
  const key = installKey(installed);
  if (key === handledInstall || restarting.peek()) return "none";
  handledInstall = key;
  if (busy.peek() > 0) {
    restartWhenIdle(busy, relaunch);
    return "wait";
  }
  void restartNow(relaunch).then(() => {
    if (updateActionError.peek()) notify("error", `Couldn't restart Glade: ${updateActionError.peek()}`);
  });
  return "restart";
}

/** A newer release build was installed into this app's bundle (never set by `pnpm dev`). */
export function installedBuild(status: VersionStatus | null): BuildInfo | null {
  if (!status?.installed || status.build?.kind !== "release") return null;
  return status.installed;
}

export interface AutoRestartOptions {
  /** Default: the Mac app's window (not browsers, the iPhone app or `pnpm dev` pages). */
  enabled?: () => boolean;
  socket?: Socket;
  busy?: ReadonlySignal<number>;
  /** The chat list is loaded (so "no chat is working" is known, not just empty). */
  ready?: ReadonlySignal<boolean>;
  relaunch?: (route: string) => Promise<void>;
}

const chatsKnown = computed(() => initialized.value && !initError.value);

/**
 * Registered once at app start (main.tsx): follows the local server's `installed` build and
 * restarts into it. Update Now reaching `installed` re-reads the version status at once.
 * Returns a stop function (tests).
 */
export function startAutoRestart(options: AutoRestartOptions = {}): () => void {
  if (!(options.enabled ?? isDesktop)()) return () => {};
  const socket = options.socket ?? localSocket;
  const ready = options.ready ?? chatsKnown;
  const stop = effect(() => {
    const installed = installedBuild(versionStatus.value);
    if (!installed || !ready.value) return;
    untracked(() => autoRestartFor(installed, options.busy, options.relaunch));
  });
  const off = socket.onMessage(function onMessage(message) {
    if (message.type === "batch") return message.messages.forEach(onMessage);
    if (message.type === "update" && message.update.state === "installed") void loadVersion();
  });
  return () => {
    stop();
    off();
  };
}

/** Tests: forget the decisions made so far. */
export function resetAutoRestart(): void {
  cancelRestartWait();
  handledInstall = null;
  restarting.value = false;
}

/** Update Now can run here: the Mac app on a server that offers it. */
export function canUpdateHere(job: UpdateJobStatus | null): boolean {
  return !!job?.available && isDesktop();
}
