/**
 * Global keyboard shortcuts: ⌘N new chat, ⌘, settings, ⌘\ toggle sidebar.
 * (Ctrl is accepted in place of ⌘ on non-Mac platforms.)
 */
import { useEffect } from "preact/hooks";

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

export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
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
