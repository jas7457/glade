/**
 * Global keyboard shortcuts: ⌘N new chat, ⌘, settings, ⌘B toggle sidebar (⌘\ as a silent
 * alias), ⌘K command palette; plus the workspace tab shortcuts (⌘T, ⌘W, ⌃Tab, ⌃⇧Tab, see
 * `TAB_SHORTCUTS`). (Ctrl is accepted in place of ⌘ on non-Mac platforms.) In the
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

/**
 * Tab shortcuts (I-036). Only active while a workspace is shown, so they live apart from
 * `SHORTCUTS` (whose handlers are always available); the workspace view binds them with
 * `useTabShortcuts`. `ctrl+tab` really is Control (not ⌘) on every platform.
 */
export const TAB_SHORTCUTS = {
  "new-tab": "mod+t",
  "close-tab": "mod+w",
  "next-tab": "ctrl+tab",
  "previous-tab": "ctrl+shift+tab",
} as const;

export type TabCommandId = keyof typeof TAB_SHORTCUTS;
export type TabShortcutHandlers = Record<TabCommandId, () => void>;

export function tabShortcutFor(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): TabCommandId | null {
  if (e.altKey) return null;
  if (e.key === "Tab") {
    if (!e.ctrlKey || e.metaKey) return null;
    return e.shiftKey ? "previous-tab" : "next-tab";
  }
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return null;
  const key = e.key.toLowerCase();
  return key === "t" ? "new-tab" : key === "w" ? "close-tab" : null;
}

/** Bind the tab shortcuts while mounted (the caller decides what they act on). */
export function useTabShortcuts(handlers: TabShortcutHandlers): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = tabShortcutFor(e);
      if (!action || e.defaultPrevented) return;
      e.preventDefault();
      latest.current[action]();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
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
