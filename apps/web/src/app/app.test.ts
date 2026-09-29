import { describe, expect, it } from "vitest";
import { makeWorkspace } from "@/test/fixtures";
import { resolveTheme } from "./appearance";
import { routeContext } from "./paths";
import { chatPath, routes } from "./routes";
import { formatShortcut } from "@/ui/Kbd";
import { PANE_SHORTCUTS, SHORTCUTS, TAB_SHORTCUTS, paneShortcutFor, shortcutFor, tabShortcutFor } from "./shortcuts";

describe("resolveTheme", () => {
  it("follows the system only when set to system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("routeContext", () => {
  const byId = new Map([["c1", makeWorkspace({ id: "c1", projectId: "p1" })]]);
  it("derives chat/project from the URL", () => {
    expect(routeContext("/projects/p1/chats/c1", byId)).toEqual({ workspaceId: "c1", projectId: "p1", isSettings: false, envId: null });
    expect(routeContext("/projects/p2", byId)).toEqual({ workspaceId: null, projectId: "p2", isSettings: false, envId: null });
    expect(routeContext("/chats/c1", byId).projectId).toBe("p1");
    expect(routeContext("/chats/zz", byId).projectId).toBeNull();
    expect(routeContext("/settings/general", byId).isSettings).toBe(true);
  });
});

describe("chat paths", () => {
  it("links to a workspace, optionally with its tab", () => {
    expect(chatPath({ id: "w", projectId: null })).toBe("/chats/w");
    expect(chatPath({ id: "w", projectId: "p" }, "s 1")).toBe("/projects/p/chats/w?tab=s%201");
    expect(routes.chat("w", null)).toBe("/chats/w");
  });
});

describe("shortcutFor", () => {
  const k = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    shortcutFor({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  it("maps ⌘N, ⌘, ⌘B (and the ⌘\\ alias) and ⌘K", () => {
    expect(k("n")).toBe("new-chat");
    expect(k(",")).toBe("settings");
    expect(k("b")).toBe("toggle-sidebar");
    expect(k("B")).toBe("toggle-sidebar");
    expect(k("\\")).toBe("toggle-sidebar");
    expect(k("k")).toBe("command-palette");
    expect(k("k", { metaKey: false, ctrlKey: true })).toBe("command-palette");
    expect(k("n", { metaKey: false })).toBeNull();
    expect(k("n", { shiftKey: true })).toBeNull();
    expect(k("b", { altKey: true })).toBeNull();
    expect(k("j")).toBeNull();
  });

  it("shows ⌘B for the sidebar", () => {
    expect(formatShortcut(SHORTCUTS["toggle-sidebar"])).toBe("⌘B");
    expect(formatShortcut(SHORTCUTS["command-palette"])).toBe("⌘K");
  });
});

describe("tabShortcutFor", () => {
  const k = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    tabShortcutFor({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  it("maps ⌘T, ⌘W, ⌃Tab and ⌃⇧Tab", () => {
    expect(k("t", { metaKey: true })).toBe("new-tab");
    expect(k("W", { metaKey: true })).toBe("close-tab");
    expect(k("Tab", { ctrlKey: true })).toBe("next-tab");
    expect(k("Tab", { ctrlKey: true, shiftKey: true })).toBe("previous-tab");
    expect(k("Tab")).toBeNull();
    expect(k("Tab", { metaKey: true })).toBeNull();
    expect(k("t")).toBeNull();
    expect(k("t", { metaKey: true, shiftKey: true })).toBeNull();
    expect(k("w", { metaKey: true, altKey: true })).toBeNull();
    expect(shortcutFor({ key: "t", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false })).toBeNull();
  });

  it("formats them natively", () => {
    expect(formatShortcut(TAB_SHORTCUTS["new-tab"])).toBe("⌘T");
    expect(formatShortcut(TAB_SHORTCUTS["previous-tab"])).toBe("⌃⇧⇥");
  });
});

describe("paneShortcutFor (I-141)", () => {
  const k = (key: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
    paneShortcutFor({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  it("maps ⌥⌘B (by physical key: ⌥B types ∫ on a Mac) and nothing else", () => {
    expect(k("∫", "KeyB", { metaKey: true, altKey: true })).toBe("toggle-subagents");
    expect(k("b", "KeyB", { ctrlKey: true, altKey: true })).toBe("toggle-subagents");
    expect(k("b", "KeyB", { metaKey: true })).toBeNull();
    expect(k("∫", "KeyB", { altKey: true })).toBeNull();
    expect(k("B", "KeyB", { metaKey: true, altKey: true, shiftKey: true })).toBeNull();
    expect(shortcutFor({ key: "∫", metaKey: true, ctrlKey: false, altKey: true, shiftKey: false })).toBeNull();
    expect(formatShortcut(PANE_SHORTCUTS["toggle-subagents"])).toBe("⌥⌘B");
  });
});
