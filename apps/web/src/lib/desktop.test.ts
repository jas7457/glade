import { afterEach, describe, expect, it, vi } from "vitest";
import { isDesktop, onMenuAction, setDockBadge } from "./desktop";

describe("desktop bridge in a browser", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("detects the Tauri webview by its injected globals", () => {
    expect(isDesktop()).toBe(false);
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    expect(isDesktop()).toBe(true);
  });

  it("is a no-op outside the desktop app", async () => {
    const handler = vi.fn();
    const off = onMenuAction(handler);
    expect(() => off()).not.toThrow();
    await expect(setDockBadge(3)).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });
});
