/**
 * Global keyboard shortcuts: ⌘N new chat, ⌘, settings, ⌘\ toggle sidebar.
 * (Ctrl is accepted in place of ⌘ on non-Mac platforms.) In the desktop app the same actions
 * also arrive from the native menu bar.
 */
import { useEffect, useRef } from "preact/hooks";
import { onMenuAction, type MenuAction } from "@/lib/desktop";

export interface ShortcutHandlers {
  newChat: () => void;
  settings: () => void;
  toggleSidebar: () => void;
}

export function shortcutFor(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): keyof ShortcutHandlers | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey || e.shiftKey) return null;
  switch (e.key.toLowerCase()) {
    case "n":
      return "newChat";
    case ",":
      return "settings";
    case "\\":
      return "toggleSidebar";
    default:
      return null;
  }
}

const MENU_ACTIONS: Record<MenuAction, keyof ShortcutHandlers> = {
  "new-chat": "newChat",
  settings: "settings",
  "toggle-sidebar": "toggleSidebar",
};

export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => onMenuAction((action) => latest.current[MENU_ACTIONS[action]]()), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action) return;
      e.preventDefault();
      handlers[action]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
}
