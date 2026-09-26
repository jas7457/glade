import { describe, expect, it } from "vitest";
import { makeChat } from "@/test/fixtures";
import { resolveTheme } from "./appearance";
import { routeContext } from "./paths";
import { shortcutFor } from "./shortcuts";

describe("resolveTheme", () => {
  it("follows the system only when set to system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("routeContext", () => {
  const byId = new Map([["c1", makeChat({ id: "c1", projectId: "p1" })]]);
  it("derives chat/project from the URL", () => {
    expect(routeContext("/projects/p1/chats/c1", byId)).toEqual({ chatId: "c1", projectId: "p1", isSettings: false });
    expect(routeContext("/projects/p2", byId)).toEqual({ chatId: null, projectId: "p2", isSettings: false });
    expect(routeContext("/chats/c1", byId).projectId).toBe("p1");
    expect(routeContext("/chats/zz", byId).projectId).toBeNull();
    expect(routeContext("/settings/general", byId).isSettings).toBe(true);
  });
});

describe("shortcutFor", () => {
  const k = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    shortcutFor({ key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  it("maps ⌘N, ⌘, and ⌘\\", () => {
    expect(k("n")).toBe("newChat");
    expect(k(",")).toBe("settings");
    expect(k("\\")).toBe("toggleSidebar");
    expect(k("n", { metaKey: false })).toBeNull();
    expect(k("n", { shiftKey: true })).toBeNull();
  });
});
