/**
 * Global keyboard shortcuts: ⌘N new chat, ⌘, settings, ⌘B toggle sidebar (⌘\ as a silent
 * alias), ⌘K command palette. (Ctrl is accepted in place of ⌘ on non-Mac platforms.) In the
 * desktop app the same actions also arrive from the native menu bar (menu item ids are the
 * command ids). `SHORTCUTS` is the one place the key bindings are defined; tooltips, the command
 * palette and `shortcutFor` all read it.
 */
import { useEffect, useRef } from "preact/hooks";
import { onMenuAction, type MenuAction } from "@/lib/desktop";

/** Commands with a global shortcut, keyed by command id, as `formatShortcut` key strings. */
export const SHORTCUTS = {
  "new-chat": "mod+n",
  settings: "mod+,",
  "toggle-sidebar": "mod+b",
  "command-palette": "mod+k",
} as const;

export type GlobalCommandId = keyof typeof SHORTCUTS;
export type ShortcutHandlers = Record<GlobalCommandId, () => void>;

/** Extra bindings that work but aren't shown anywhere. */
const ALIASES: Record<string, GlobalCommandId> = {
  "mod+\\": "toggle-sidebar",
};

const BINDINGS: ReadonlyMap<string, GlobalCommandId> = new Map([
  ...Object.entries(SHORTCUTS).map(([id, keys]) => [keys, id as GlobalCommandId] as const),
  ...Object.entries(ALIASES),
]);

export function shortcutFor(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): GlobalCommandId | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey || e.shiftKey) return null;
  return BINDINGS.get(`mod+${e.key.toLowerCase()}`) ?? null;
}

const MENU_ACTIONS: Record<MenuAction, GlobalCommandId> = {
  "new-chat": "new-chat",
  settings: "settings",
  "toggle-sidebar": "toggle-sidebar",
  "command-palette": "command-palette",
};

export function useGlobalShortcuts(handlers: ShortcutHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => onMenuAction((action) => latest.current[MENU_ACTIONS[action]]()), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e);
      if (!action) return;
      // ⌘B means "bold" in rich-text editors; leave it to them.
      if (action === "toggle-sidebar" && (e.target as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      latest.current[action]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
