/**
 * Bridge to the Tauri desktop shell (apps/desktop). Everything here is a no-op in a normal
 * browser: `@tauri-apps/*` modules are only imported dynamically once `isDesktop()` is true, so
 * the web build never touches Tauri APIs outside the app.
 *
 * The shell marks <html data-desktop> (see index.html) so CSS can adapt, e.g. the translucent
 * sidebar over the window's vibrancy.
 */

/** True when running inside the pi-ui desktop app (Tauri webview). */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Custom app-menu items (ids from apps/desktop/src-tauri/src/menu.rs). */
export type MenuAction = "new-chat" | "settings" | "toggle-sidebar" | "command-palette";
const MENU_EVENT = "pi-ui:menu";

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

/** Notification permission via the native notification plugin. */
export async function nativeNotificationPermission(request: boolean): Promise<NotificationPermission> {
  const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
  if (await isPermissionGranted()) return "granted";
  return request ? await requestPermission() : "default";
}

/** Post a native macOS notification (clicking it brings the app to the front). */
export async function sendNativeNotification(title: string, body: string): Promise<void> {
  const { sendNotification } = await import("@tauri-apps/plugin-notification");
  sendNotification({ title, body });
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
