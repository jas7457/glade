/**
 * Menu bar (tray) items that open something in the window (I-150, `src-tauri/src/tray.rs`; the
 * shell has already shown the window at the screen it was on):
 * - "N chats working" → a chat that's working; "N chats need you" → one waiting for input or
 *   unread. Repeated clicks cycle through them (the next one after the chat on screen).
 * - `remote-settings` → Settings → Remote Access (the sharing toggle couldn't turn it on).
 * Only this Mac's chats count, like the menu bar's numbers.
 */
import { useEffect, useRef } from "preact/hooks";
import { needsAttention, type WorkspaceSummary } from "@glade/protocol";
import { onMenuAction } from "@/lib/desktop";
import { chatPath, routes } from "./routes";

export type ChatFilter = "working" | "needs-you";

/** The chat to open for a filter: the first match after `currentId` (wrapping), else the first. */
export function pickChat(workspaces: readonly WorkspaceSummary[], filter: ChatFilter, currentId: string | null): WorkspaceSummary | null {
  const matches = workspaces.filter(
    (w) => !w.environmentId && (filter === "working" ? w.status === "working" : needsAttention(w.status)),
  );
  if (!matches.length) return null;
  const at = currentId ? matches.findIndex((w) => w.id === currentId) : -1;
  return matches[(at + 1) % matches.length]!;
}

export function useMenuBarActions(navigate: (path: string) => void, workspaces: () => readonly WorkspaceSummary[], currentId: () => string | null): void {
  const latest = useRef({ navigate, workspaces, currentId });
  latest.current = { navigate, workspaces, currentId };
  useEffect(
    () =>
      onMenuAction((action) => {
        const { navigate, workspaces, currentId } = latest.current;
        if (action === "remote-settings") return navigate(routes.settings("remote"));
        if (action !== "show-working" && action !== "show-needs-you") return;
        const chat = pickChat(workspaces(), action === "show-working" ? "working" : "needs-you", currentId());
        if (chat) navigate(chatPath(chat));
      }),
    [],
  );
}
