/**
 * System notifications for chats (I-135; reverses I-028 by the user's decision).
 *
 * - **Settings** are per device (localStorage, like the sidebar), in Settings → General:
 *   needs input / finished / failed (each on by default) and "only while Glade is in the
 *   background" (on).
 * - **What triggers one:** a live `session_upsert` from any connected environment (local or
 *   remote) whose status changed: no open dialog → one (needs input), running → done (finished),
 *   running/ok → failed or interrupted (fails). `state/sync.ts` only passes pushes received after
 *   the shell scope's `live` marker (I-122), so replays and snapshots after a (re)connect never
 *   notify, and a push seen twice isn't a transition the second time.
 * - **Which chats:** top-level (`main`) sessions only. Sub-agents are off by design: they report
 *   into their parent chat, which notifies when *it* finishes or needs input.
 * - **Several windows of the same app** (same origin, e.g. two browser tabs): each banner has a
 *   tag per chat and kind, so copies replace each other, and the first window to claim a
 *   transition in localStorage shows it (the others skip it for a few seconds).
 * - **Clicking** a banner focuses Glade and opens that chat (`requestOpenChat`, so remote chats
 *   get their `/e/:env/…` route).
 *
 * The Dock badge and window-title count are separate (`state/attention.ts`).
 */
import { signal } from "@preact/signals";
import type { SessionSummary } from "@glade/protocol";
import { defaultBackend, type NotificationTarget, type NotifierBackend, type NotifyPermission, type SystemNotification } from "@/lib/system-notifications";
import { currentWorkspaceId } from "./attention";
import { environmentLabel, isLocalEnvironment } from "./env-registry";
import { requestOpenChat } from "./open-chat";
import { workspacesById } from "./store";

// Settings -----------------------------------------------------------------------------------

export interface NotificationPrefs {
  needsInput: boolean;
  finished: boolean;
  failed: boolean;
  /** Only while no Glade window is in front. */
  backgroundOnly: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { needsInput: true, finished: true, failed: true, backgroundOnly: true };
const PREFS_KEY = "glade.notifications";

function loadPrefs(): NotificationPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<NotificationPrefs> | null;
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS };
    if (raw && typeof raw === "object") for (const key of Object.keys(prefs) as (keyof NotificationPrefs)[]) if (typeof raw[key] === "boolean") prefs[key] = raw[key];
    return prefs;
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

export const notificationPrefs = signal<NotificationPrefs>(loadPrefs());

/** Tests: read the stored settings again. */
export function reloadNotificationPrefs(): void {
  notificationPrefs.value = loadPrefs();
}

const anyKindOn = (p: NotificationPrefs) => p.needsInput || p.finished || p.failed;

/** Change settings on this device. Turning a kind on asks for permission the first time. */
export function updateNotificationPrefs(patch: Partial<NotificationPrefs>): void {
  const next = { ...notificationPrefs.value, ...patch };
  const enabling = anyKindOn(next) && Object.entries(patch).some(([k, v]) => v === true && k !== "backgroundOnly");
  notificationPrefs.value = next;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
  if (enabling && notificationPermission.value === "default") void requestNotificationPermission();
}

// Permission ---------------------------------------------------------------------------------

let backend: NotifierBackend | null = null;
function getBackend(): NotifierBackend {
  return (backend ??= defaultBackend());
}

/** Whether this client may show banners (`denied`: turned off in System/browser settings). */
export const notificationPermission = signal<NotifyPermission>("default");

export async function refreshNotificationPermission(): Promise<NotifyPermission> {
  notificationPermission.value = await getBackend().permission();
  return notificationPermission.value;
}

let requesting: Promise<NotifyPermission> | null = null;
export function requestNotificationPermission(): Promise<NotifyPermission> {
  requesting ??= getBackend()
    .request()
    .then((p) => (notificationPermission.value = p))
    .finally(() => {
      requesting = null;
    });
  return requesting;
}

// Transitions --------------------------------------------------------------------------------

export type NotifyKind = "needs-input" | "finished" | "failed";

/**
 * What changed between two states of one session, as far as notifications go (`null`: nothing
 * to tell). `prev` undefined (a session we didn't know) is never a transition.
 */
export function detectNotification(prev: SessionSummary | undefined, next: SessionSummary): NotifyKind | null {
  // Sub-agents never notify (see the header): their parent does.
  if (!prev || next.kind !== "main") return null;
  if (prev.pendingInputs === 0 && next.pendingInputs > 0) return "needs-input";
  if (next.running || next.pendingInputs > 0) return null;
  const failed = !!next.lastRunFailed || !!next.interrupted;
  if (failed && (prev.running || (!prev.lastRunFailed && !prev.interrupted))) return "failed";
  if (!failed && prev.running) return "finished";
  return null;
}

/** Whether the app window is in front (a focused, visible window). */
export function appInForeground(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

/** The settings/focus gate. `onScreen`: the chat is the one open in this window. */
export function shouldNotify(kind: NotifyKind, prefs: NotificationPrefs, foreground: boolean, onScreen: boolean): boolean {
  const enabled = kind === "needs-input" ? prefs.needsInput : kind === "finished" ? prefs.finished : prefs.failed;
  if (!enabled) return false;
  if (!foreground) return true;
  // In front: never for the chat you're looking at, and not at all when "background only".
  return !prefs.backgroundOnly && !onScreen;
}

const FALLBACK_LINE: Record<NotifyKind, string> = { "needs-input": "Needs your input", finished: "Finished", failed: "Failed" };

/** The banner for a transition. `envId` undefined/local: no "On …" subtitle. */
export function buildNotification(kind: NotifyKind, session: SessionSummary, envId: string | undefined, workspaceTitle?: string): SystemNotification {
  const remote = !!envId && !isLocalEnvironment(envId);
  const line = session.attentionLine ?? (kind === "failed" && session.interrupted ? "Interrupted" : FALLBACK_LINE[kind]);
  return {
    tag: `glade:${envId ?? "local"}:${session.id}:${kind}`,
    title: workspaceTitle || session.title || "Chat",
    ...(remote ? { subtitle: `On ${environmentLabel(envId)}` } : {}),
    body: line,
    target: { envId: remote ? envId! : null, workspaceId: session.workspaceId, sessionId: session.id },
  };
}

// Several windows ------------------------------------------------------------------------------

const windowId = Math.random().toString(36).slice(2);
const CLAIM_PREFIX = "glade.notify.claim:";
const CLAIM_MS = 5000;

/** First window to claim a transition shows it (best effort; the banner tag covers races). */
function claim(key: string): boolean {
  try {
    const raw = localStorage.getItem(CLAIM_PREFIX + key);
    const [owner, at] = raw ? raw.split("@") : [];
    if (owner && owner !== windowId && Date.now() - Number(at) < CLAIM_MS) return false;
    localStorage.setItem(CLAIM_PREFIX + key, `${windowId}@${Date.now()}`);
  } catch {
    /* storage unavailable: show it */
  }
  return true;
}

// Wiring -------------------------------------------------------------------------------------

/** A live session push (called by `state/sync.ts` only after the shell's `live` marker). */
export function observeSessionUpsert(prev: SessionSummary | undefined, next: SessionSummary, envId: string | undefined): void {
  const kind = detectNotification(prev, next);
  if (!kind) return;
  const onScreen = currentWorkspaceId.value === next.workspaceId;
  if (!shouldNotify(kind, notificationPrefs.value, appInForeground(), onScreen)) return;
  const notification = buildNotification(kind, next, envId, workspacesById.value.get(next.workspaceId)?.title);
  if (!claim(`${notification.tag}:${next.lastActivityAt}`)) return;
  void show(notification);
}

async function show(notification: SystemNotification): Promise<void> {
  let permission = notificationPermission.value;
  if (permission === "default") permission = await requestNotificationPermission();
  if (permission !== "granted") return;
  await getBackend()
    .show(notification)
    .catch(() => {});
}

/** A banner was clicked: open its chat (the backend already focused the app). */
export function openNotificationTarget(target: NotificationTarget): void {
  requestOpenChat({ workspaceId: target.workspaceId, sessionId: target.sessionId, sessionKind: "main" });
}

let stopClicks: (() => void) | null = null;

/** Call once at startup (tests pass a fake backend). */
export function startNotifications(custom?: NotifierBackend): void {
  if (custom) backend = custom;
  stopClicks?.();
  stopClicks = getBackend().onClick(openNotificationTarget);
  void refreshNotificationPermission();
  // The user may change it in System Settings meanwhile: check again when Glade comes to the front.
  if (!custom && typeof window !== "undefined") window.addEventListener("focus", () => void refreshNotificationPermission());
}
