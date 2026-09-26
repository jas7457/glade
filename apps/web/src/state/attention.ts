/**
 * Chat attention: counts for badges / the window title, and alerts when a chat finishes or
 * needs input while the user is looking elsewhere.
 *
 *  - `chatAlertEvent(prev, next)` (pure) detects "finished" (working/blocked → unread) and
 *    "blocked" (→ blocked) transitions.
 *  - `alertChannel(ctx)` (pure) picks where to show it: a system Notification when the window
 *    is hidden/unfocused, an in-app toast when you're in the app but viewing another chat,
 *    nothing when that chat is already on screen.
 *  - `startAttentionSync()` wires both to the `chats` signal and keeps document.title updated.
 */
import { computed, effect, signal, untracked } from "@preact/signals";
import { needsAttention, type ChatSummary } from "@pi-ui/protocol";
import { chats, chatsById, settings } from "./store";
import { showToast } from "./toasts";

const active = computed(() => chats.value.filter((c) => !c.archived));

/** Chats that are unread or blocked (the badge number). */
export const attentionCount = computed(() => active.value.filter((c) => needsAttention(c.status)).length);
/** Chats with a running agent (includes blocked ones, which are mid-run). */
export const workingCount = computed(() => active.value.filter((c) => c.status === "working" || c.status === "blocked").length);

/** Chat currently on screen (set by the app shell from the route). */
export const currentChatId = signal<string | null>(null);

export interface ChatAlertEvent {
  kind: "finished" | "blocked";
  chat: ChatSummary;
  failed: boolean;
}

export function chatAlertEvent(prev: ChatSummary | undefined, next: ChatSummary): ChatAlertEvent | null {
  if (!prev || prev.status === next.status) return null;
  if (next.status === "blocked") return { kind: "blocked", chat: next, failed: false };
  if (next.status === "unread" && (prev.status === "working" || prev.status === "blocked")) {
    return { kind: "finished", chat: next, failed: !!next.lastRunFailed };
  }
  return null;
}

export interface AlertContext {
  chatId: string;
  currentChatId: string | null;
  documentHidden: boolean;
  windowFocused: boolean;
}

export function alertChannel(ctx: AlertContext): "system" | "toast" | null {
  if (ctx.documentHidden || !ctx.windowFocused) return "system";
  if (ctx.currentChatId !== ctx.chatId) return "toast";
  return null;
}

export function alertText(event: ChatAlertEvent): { title: string; body: string } {
  const name = event.chat.title || "Untitled chat";
  if (event.kind === "blocked") return { title: `${name} needs your input`, body: "The agent is waiting for your answer." };
  if (event.failed) return { title: `${name} finished`, body: "The last run failed." };
  return { title: `${name} finished`, body: "New messages are ready." };
}

/** Window title: "(2) Chat title — pi-ui". */
export function windowTitle(attention: number, chatTitle?: string | null): string {
  return `${attention > 0 ? `(${attention}) ` : ""}${chatTitle ? `${chatTitle} — ` : ""}pi-ui`;
}

/** Ask for notification permission if it hasn't been decided yet. */
export async function ensureNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "default") {
    try {
      return await Notification.requestPermission();
    } catch {
      return Notification.permission;
    }
  }
  return Notification.permission;
}

let openChat: (chat: ChatSummary) => void = () => {};
/** The app shell registers how to navigate to a chat (used by notification clicks). */
export function setChatOpener(fn: (chat: ChatSummary) => void): void {
  openChat = fn;
}

function deliver(event: ChatAlertEvent): void {
  const channel = alertChannel({
    chatId: event.chat.id,
    currentChatId: currentChatId.value,
    documentHidden: document.hidden,
    windowFocused: document.hasFocus(),
  });
  if (!channel) return;
  const { title, body } = alertText(event);
  if (channel === "toast") {
    showToast({
      level: event.kind === "blocked" ? "warning" : event.failed ? "error" : "info",
      title,
      message: body,
      action: { label: "View", onClick: () => openChat(event.chat) },
      timeoutMs: 6000,
    });
    return;
  }
  if (!settings.value.general.notifyOnComplete || typeof Notification === "undefined") return;
  const show = () => {
    const n = new Notification(title, { body, tag: `pi-ui-${event.chat.id}` });
    n.onclick = () => {
      window.focus();
      openChat(event.chat);
      n.close();
    };
  };
  if (Notification.permission === "granted") show();
  else if (Notification.permission === "default") {
    void ensureNotificationPermission().then((p) => p === "granted" && show());
  }
}

let started = false;

export function startAttentionSync(): void {
  if (started) return;
  started = true;
  let previous = new Map<string, ChatSummary>();
  effect(() => {
    const next = chatsById.value;
    for (const [id, chat] of next) {
      const event = chatAlertEvent(previous.get(id), chat);
      if (event) untracked(() => deliver(event));
    }
    previous = next;
  });
  effect(() => {
    const current = currentChatId.value ? chatsById.value.get(currentChatId.value) : null;
    document.title = windowTitle(attentionCount.value, current?.title);
  });
}
