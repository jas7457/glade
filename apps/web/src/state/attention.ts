/**
 * Chat attention: the counts behind the window title and the desktop Dock badge.
 *
 * pi-ui deliberately has no system notifications or "chat finished" toasts (I-028): status is
 * shown in the sidebar, the `(n) pi-ui` window title, and the Dock badge in the desktop app.
 */
import { computed, effect, signal } from "@preact/signals";
import { needsAttention } from "@pi-ui/protocol";
import { isDesktop, setDockBadge } from "@/lib/desktop";
import { chats, chatsById } from "./store";

/** Chats that are unread, waiting for input, or interrupted (the badge number). */
export const attentionCount = computed(() => chats.value.filter((c) => needsAttention(c.status)).length);
/** Chats with a running agent (includes blocked ones, which are mid-run). */
export const workingCount = computed(() => chats.value.filter((c) => c.status === "working" || c.status === "blocked").length);

/** Chat currently on screen (set by the app shell from the route). */
export const currentChatId = signal<string | null>(null);

/** Window title: "(2) Chat title — pi-ui". */
export function windowTitle(attention: number, chatTitle?: string | null): string {
  return `${attention > 0 ? `(${attention}) ` : ""}${chatTitle ? `${chatTitle} — ` : ""}pi-ui`;
}

let started = false;

/** Keep document.title (and, in the desktop app, the Dock badge) in sync. Call once at startup. */
export function startAttentionSync(): void {
  if (started) return;
  started = true;
  effect(() => {
    const current = currentChatId.value ? chatsById.value.get(currentChatId.value) : null;
    document.title = windowTitle(attentionCount.value, current?.title);
  });
  if (isDesktop()) {
    effect(() => {
      void setDockBadge(attentionCount.value).catch(() => {});
    });
  }
}
