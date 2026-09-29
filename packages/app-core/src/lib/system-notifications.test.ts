import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listeners = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: (e: { payload: unknown }) => void) => (listeners.set(name, handler), () => listeners.delete(name)),
}));

import { desktopBackend, parseTarget, webBackend, type SystemNotification } from "./system-notifications";

const target = { envId: "B", workspaceId: "w1", sessionId: "s1" };
const banner: SystemNotification = { tag: "glade:B:s1:finished", title: "Fix login", subtitle: "On Mac Studio", body: "Done.", target };
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  delete (window as unknown as Record<string, unknown>).Notification;
  invoke.mockReset();
  listeners.clear();
});

describe("system notification backends (I-135)", () => {
  it("parses click data", () => {
    expect(parseTarget(JSON.stringify(target))).toEqual(target);
    expect(parseTarget('{"workspaceId":"w","sessionId":"s"}')).toEqual({ envId: null, workspaceId: "w", sessionId: "s" });
    expect(parseTarget("nope")).toBeNull();
  });

  it("Mac app: commands, and clicks incl. one that launched the app", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invoke.mockImplementation(async (cmd: string) => (cmd === "notify_ready" ? JSON.stringify(target) : cmd === "notify_permission" ? "denied" : undefined));
    const b = desktopBackend();
    await expect(b.permission()).resolves.toBe("denied");
    await b.show(banner);
    expect(invoke).toHaveBeenCalledWith("notify_show", { id: banner.tag, title: "Fix login", subtitle: "On Mac Studio", body: "Done.", data: JSON.stringify(target) });
    const clicks: unknown[] = [];
    b.onClick((t) => clicks.push(t));
    await flush();
    await flush();
    expect(clicks).toEqual([target]); // the pending one from notify_ready
    listeners.get("glade:notification-click")!({ payload: JSON.stringify({ ...target, sessionId: "s2" }) });
    expect(clicks).toHaveLength(2);
  });

  it("browser: the Notification API with a tag; a click focuses and routes", async () => {
    const created: Array<{ title: string; options: NotificationOptions; onclick?: () => void; close: () => void }> = [];
    class FakeNotification {
      static permission = "granted";
      static requestPermission = vi.fn(async () => "granted");
      onclick?: () => void;
      close = vi.fn();
      constructor(
        public title: string,
        public options: NotificationOptions,
      ) {
        created.push(this);
      }
    }
    (window as unknown as Record<string, unknown>).Notification = FakeNotification;
    const focus = vi.spyOn(window, "focus").mockImplementation(() => {});
    const b = webBackend();
    const clicks: unknown[] = [];
    b.onClick((t) => clicks.push(t));
    await b.show(banner);
    expect(created[0]!.title).toBe("Fix login");
    expect(created[0]!.options).toMatchObject({ body: "On Mac Studio\nDone.", tag: banner.tag });
    created[0]!.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(clicks).toEqual([target]);
  });
});
