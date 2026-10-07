import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/preact";
import type { MenuAction } from "@glade/app-core/lib/desktop";

// Capture the desktop menu listeners so the test can play menu clicks.
const listeners = new Set<(action: MenuAction) => void>();
vi.mock("@glade/app-core/lib/desktop", () => ({
  onMenuAction: (handler: (action: MenuAction) => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },
}));

const { terminalShortcutFor, useGlobalShortcuts, useTabShortcuts } = await import("./shortcuts");
const { setFocusedTerminal } = await import("@/features/terminal/focus");

const menu = (action: MenuAction) => listeners.forEach((l) => l(action));

describe("menu actions (desktop app menu)", () => {
  afterEach(cleanup);

  it("routes tab items to the tab shortcuts and the rest to the global ones", () => {
    const global = { "new-chat": vi.fn(), settings: vi.fn(), "toggle-sidebar": vi.fn(), "command-palette": vi.fn() };
    const tabs = { "new-tab": vi.fn(), "close-tab": vi.fn(), "next-tab": vi.fn(), "previous-tab": vi.fn() };
    renderHook(() => useGlobalShortcuts(global));
    const { unmount } = renderHook(() => useTabShortcuts(tabs));

    menu("close-tab");
    menu("previous-tab");
    menu("new-chat");
    expect(tabs["close-tab"]).toHaveBeenCalledTimes(1);
    expect(tabs["previous-tab"]).toHaveBeenCalledTimes(1);
    expect(global["new-chat"]).toHaveBeenCalledTimes(1);
    expect(tabs["new-tab"]).not.toHaveBeenCalled();

    // No workspace shown: tab items do nothing.
    unmount();
    menu("new-tab");
    expect(tabs["new-tab"]).not.toHaveBeenCalled();
  });
});

describe("terminal tabs (I-187)", () => {
  afterEach(cleanup);

  it("⌃` (and ⌃⇧`) opens a terminal; ⌘` and ⌥⌃` don't", () => {
    const k = (o: Partial<KeyboardEvent>) => ({ key: "`", code: "Backquote", metaKey: false, ctrlKey: false, altKey: false, ...o });
    expect(terminalShortcutFor(k({ ctrlKey: true }))).toBe("new-terminal");
    expect(terminalShortcutFor(k({ ctrlKey: true, key: "~" }))).toBe("new-terminal");
    expect(terminalShortcutFor(k({ metaKey: true }))).toBeNull();
    expect(terminalShortcutFor(k({ ctrlKey: true, altKey: true }))).toBeNull();
    expect(terminalShortcutFor(k({ ctrlKey: true, key: "a", code: "KeyA" }))).toBeNull();
  });

  it("the menu's ⌘K clears a focused terminal instead of opening the palette", () => {
    const global = { "new-chat": vi.fn(), settings: vi.fn(), "toggle-sidebar": vi.fn(), "command-palette": vi.fn() };
    renderHook(() => useGlobalShortcuts(global));
    const terminal = { clear: vi.fn(), focus: vi.fn() };
    setFocusedTerminal(terminal);
    menu("command-palette");
    expect(terminal.clear).toHaveBeenCalledOnce();
    expect(global["command-palette"]).not.toHaveBeenCalled();
    setFocusedTerminal(null, terminal);
    menu("command-palette");
    expect(global["command-palette"]).toHaveBeenCalledOnce();
  });
});

describe("bookmark shortcuts (I-203)", () => {
  it("⌘D bookmarks the latest reply, ⌘⇧D shows the list; ⌥ or no modifier is nothing", async () => {
    const { bookmarkShortcutFor, BOOKMARK_SHORTCUTS, SHORTCUTS, TAB_SHORTCUTS, PANE_SHORTCUTS, TERMINAL_SHORTCUTS } = await import("./shortcuts");
    const k = (over: Partial<KeyboardEvent>) => ({ key: "d", code: "KeyD", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over });
    expect(bookmarkShortcutFor(k({ metaKey: true }))).toBe("bookmark-reply");
    expect(bookmarkShortcutFor(k({ metaKey: true, shiftKey: true, key: "D" }))).toBe("show-bookmarks");
    expect(bookmarkShortcutFor(k({ ctrlKey: true }))).toBe("bookmark-reply");
    expect(bookmarkShortcutFor(k({ metaKey: true, altKey: true, key: "∂" }))).toBeNull();
    expect(bookmarkShortcutFor(k({}))).toBeNull();
    expect(bookmarkShortcutFor(k({ metaKey: true, key: "k", code: "KeyK" }))).toBeNull();
    // No other shortcut uses these keys.
    const others: string[] = [...Object.values(SHORTCUTS), ...Object.values(TAB_SHORTCUTS), ...Object.values(PANE_SHORTCUTS), ...Object.values(TERMINAL_SHORTCUTS)];
    for (const keys of Object.values(BOOKMARK_SHORTCUTS)) expect(others).not.toContain(keys);
  });
});
