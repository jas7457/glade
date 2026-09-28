/**
 * Where system notifications go (I-135): the Mac app's notification center (`lib/desktop.ts`),
 * or the web Notification API in a browser. `state/notifications.ts` decides *what* to show;
 * this only shows banners, reports the permission and hands clicks back.
 *
 * Portable client core (F-022): the phone app plugs in its own backend.
 */
import { isDesktop, nativeNotificationPermission, onNativeNotificationClick, showNativeNotification } from "./desktop";

/** `unavailable`: this client can't show notifications at all. */
export type NotifyPermission = "granted" | "denied" | "default" | "unavailable";

/** The chat a banner opens. `envId`: `null` for this machine. */
export interface NotificationTarget {
  envId: string | null;
  workspaceId: string;
  sessionId: string;
}

export interface SystemNotification {
  /** Same tag = same banner (a newer one replaces it; other windows' copies collapse into one). */
  tag: string;
  title: string;
  /** "On Mac Studio" for remote chats. */
  subtitle?: string;
  body: string;
  target: NotificationTarget;
}

export interface NotifierBackend {
  permission(): Promise<NotifyPermission>;
  /** Ask the user (the system prompt); resolves to the new state. */
  request(): Promise<NotifyPermission>;
  show(notification: SystemNotification): Promise<void>;
  /** Clicks on banners (the backend focuses the app first). */
  onClick(handler: (target: NotificationTarget) => void): () => void;
}

export function parseTarget(data: unknown): NotificationTarget | null {
  try {
    const t = (typeof data === "string" ? JSON.parse(data) : data) as Partial<NotificationTarget> | null;
    if (!t || typeof t.workspaceId !== "string" || typeof t.sessionId !== "string") return null;
    return { envId: typeof t.envId === "string" ? t.envId : null, workspaceId: t.workspaceId, sessionId: t.sessionId };
  } catch {
    return null;
  }
}

/** The Mac app (UNUserNotificationCenter). */
export function desktopBackend(): NotifierBackend {
  return {
    permission: () => nativeNotificationPermission(false).catch(() => "unavailable" as const),
    request: () => nativeNotificationPermission(true).catch(() => "unavailable" as const),
    show: (n) => showNativeNotification({ id: n.tag, title: n.title, subtitle: n.subtitle, body: n.body, data: JSON.stringify(n.target) }),
    onClick: (handler) =>
      onNativeNotificationClick((data) => {
        const target = parseTarget(data);
        if (target) handler(target);
      }),
  };
}

/** A browser: the web Notification API (secure contexts only; localhost counts). */
export function webBackend(): NotifierBackend {
  const handlers = new Set<(target: NotificationTarget) => void>();
  const api = () => (typeof window !== "undefined" && "Notification" in window ? window.Notification : null);
  const state = (): NotifyPermission => {
    const N = api();
    return N ? (N.permission as NotifyPermission) : "unavailable";
  };
  return {
    permission: async () => state(),
    request: async () => {
      const N = api();
      if (!N) return "unavailable";
      try {
        return (await N.requestPermission()) as NotifyPermission;
      } catch {
        return state();
      }
    },
    show: async (n) => {
      const N = api();
      if (!N || N.permission !== "granted") return;
      const banner = new N(n.title, { body: n.subtitle ? `${n.subtitle}\n${n.body}` : n.body, tag: n.tag, data: n.target });
      banner.onclick = () => {
        window.focus();
        banner.close();
        for (const handler of handlers) handler(n.target);
      };
    },
    onClick: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

export function defaultBackend(): NotifierBackend {
  return isDesktop() ? desktopBackend() : webBackend();
}
