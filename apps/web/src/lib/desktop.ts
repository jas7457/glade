/**
 * Bridge to the Tauri desktop shell (apps/desktop). Everything here is a no-op in a normal
 * browser: `@tauri-apps/*` modules are only imported dynamically once `isDesktop()` is true, so
 * the web build never touches Tauri APIs outside the app.
 *
 * The shell marks <html data-desktop> (see index.html) so CSS can adapt, e.g. the translucent
 * sidebar over the window's vibrancy.
 */

/** True when running inside the Glade desktop app (Tauri webview). */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Custom app-menu items (ids from apps/desktop/src-tauri/src/menu.rs). */
export type MenuAction =
  | "new-chat"
  | "settings"
  | "toggle-sidebar"
  | "command-palette"
  // Tab items (File → New Tab / Close Tab, Window → Show Next / Previous Tab).
  | "new-tab"
  | "close-tab"
  | "next-tab"
  | "previous-tab";
const MENU_EVENT = "glade:menu";

/** Listen for app-menu actions. Returns an unsubscribe function (safe to call immediately). */
export function onMenuAction(handler: (action: MenuAction) => void): () => void {
  if (!isDesktop()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void import("@tauri-apps/api/event").then(async ({ listen }) => {
    const off = await listen<MenuAction>(MENU_EVENT, (e) => handler(e.payload));
    if (disposed) off();
    else unlisten = off;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Native "choose folder" dialog. `null` means cancelled. */
export async function pickFolderNative(options: { prompt?: string; defaultPath?: string }): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ directory: true, multiple: false, title: options.prompt, defaultPath: options.defaultPath });
  return typeof path === "string" ? path : null;
}

/** Dock badge; 0 clears it. */
export async function setDockBadge(count: number): Promise<void> {
  if (!isDesktop()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setBadgeCount(count > 0 ? count : undefined);
}

/** Match the native window chrome (traffic lights, vibrancy) to the app theme. */
export async function setWindowTheme(theme: "light" | "dark" | null): Promise<void> {
  if (!isDesktop()) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTheme(theme);
}

/**
 * Open a URL in the default app (browser, mail) via the opener plugin (I-129). The capability
 * allows http/https/mailto only. Outside the desktop app it opens a new browser tab.
 */
export async function openExternal(url: string): Promise<void> {
  if (!isDesktop()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}

/**
 * System notifications in the Mac app (I-135), through the app's own UNUserNotificationCenter
 * commands (`src-tauri/src/notifications.rs`; the notification plugin can't route clicks or
 * report "denied" on macOS). `unavailable`: no notification center (e.g. a build without a real
 * app bundle).
 */
export type NativeNotificationPermission = "granted" | "denied" | "default" | "unavailable";

export async function nativeNotificationPermission(request = false): Promise<NativeNotificationPermission> {
  if (!isDesktop()) return "unavailable";
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<NativeNotificationPermission>(request ? "notify_request" : "notify_permission");
}

/** Post a banner; `id` replaces an earlier one with the same id; `data` comes back on click. */
export async function showNativeNotification(n: { id: string; title: string; subtitle?: string; body: string; data: string }): Promise<void> {
  if (!isDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("notify_show", { id: n.id, title: n.title, subtitle: n.subtitle ?? null, body: n.body, data: n.data });
}

const NOTIFICATION_CLICK_EVENT = "glade:notification-click";

/**
 * Clicks on the app's banners (the app is already focused by then). Also delivers a click that
 * launched the app before the page was ready (`notify_ready` hands it over once).
 */
export function onNativeNotificationClick(handler: (data: string) => void): () => void {
  if (!isDesktop()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void (async () => {
    const { listen } = await import("@tauri-apps/api/event");
    const off = await listen<string>(NOTIFICATION_CLICK_EVENT, (e) => handler(e.payload));
    if (disposed) return off();
    unlisten = off;
    const { invoke } = await import("@tauri-apps/api/core");
    const pending = await invoke<string | null>("notify_ready").catch(() => null);
    if (pending && !disposed) handler(pending);
  })();
  return () => {
    disposed = true;
    unlisten?.();
  };
}
