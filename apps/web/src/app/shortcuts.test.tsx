import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/preact";
import type { MenuAction } from "@/lib/desktop";

// Capture the desktop menu listeners so the test can play menu clicks.
const listeners = new Set<(action: MenuAction) => void>();
vi.mock("@/lib/desktop", () => ({
  onMenuAction: (handler: (action: MenuAction) => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  },
}));

const { useGlobalShortcuts, useTabShortcuts } = await import("./shortcuts");

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
