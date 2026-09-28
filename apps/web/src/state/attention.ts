/**
 * Attention (per workspace = sidebar row, with its sessions' status rolled up): the counts behind the window title and the desktop Dock badge.
 *
 * Status is shown in the sidebar, the `(n) Glade` window title, and the Dock badge in the desktop
 * app. System notifications (I-135, with a setting) live in `state/notifications.ts`.
 */
import { computed, effect, signal } from "@preact/signals";
import { needsAttention } from "@glade/protocol";
import { isDesktop, setDockBadge } from "@/lib/desktop";
import { workspaces, workspacesById } from "./store";

/** Workspaces that are unread, waiting for input, or interrupted (the badge number). */
export const attentionCount = computed(() => workspaces.value.filter((w) => needsAttention(w.status)).length);
/** Workspaces with a running agent (includes blocked ones, which are mid-run). */
export const workingCount = computed(() => workspaces.value.filter((w) => w.status === "working" || w.status === "blocked").length);

/** Workspace currently on screen (set by the app shell from the route). */
export const currentWorkspaceId = signal<string | null>(null);

/** Window title: "(2) Chat title — Glade". */
export function windowTitle(attention: number, chatTitle?: string | null): string {
  return `${attention > 0 ? `(${attention}) ` : ""}${chatTitle ? `${chatTitle} — ` : ""}Glade`;
}

let started = false;

/** Keep document.title (and, in the desktop app, the Dock badge) in sync. Call once at startup. */
export function startAttentionSync(): void {
  if (started) return;
  started = true;
  effect(() => {
    const current = currentWorkspaceId.value ? workspacesById.value.get(currentWorkspaceId.value) : null;
    document.title = windowTitle(attentionCount.value, current?.title);
  });
  if (isDesktop()) {
    effect(() => {
      void setDockBadge(attentionCount.value).catch(() => {});
    });
  }
}
