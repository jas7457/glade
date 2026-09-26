import { signal } from "@preact/signals";
import type { ClientMessage, ServerMessage } from "@pi-ui/protocol";

export type { ClientMessage };

export const connectionStatus = signal<"connecting" | "open" | "closed">("connecting");

type Handler = (message: ServerMessage) => void;

/**
 * Auto-reconnecting WebSocket to `/ws`. The server pushes {@link ServerMessage}s; the client
 * only reports which sessions are on screen.
 */
export class Socket {
  private ws: WebSocket | null = null;
  private readonly handlers = new Set<Handler>();
  private readonly reconnectHandlers = new Set<() => void>();
  private retry = 0;
  private lastViewing: ClientMessage | null = null;
  /** Sessions shown by mounted views (a count, since several views may show the same one). */
  private readonly watched = new Map<string, number>();
  private stopped = false;

  constructor(private readonly url = defaultUrl()) {
    // A session only counts as "being read" while the window is visible; otherwise finished
    // runs must still become unread.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => this.syncViewing());
    }
  }

  /**
   * Report that a session is on screen until the returned function is called. Several sessions
   * can be watched at once (e.g. a main tab and a sub-agent side by side).
   */
  watch(sessionId: string): () => void {
    this.watched.set(sessionId, (this.watched.get(sessionId) ?? 0) + 1);
    this.syncViewing();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.watched.get(sessionId) ?? 1) - 1;
      if (count <= 0) this.watched.delete(sessionId);
      else this.watched.set(sessionId, count);
      this.syncViewing();
    };
  }

  private syncViewing(): void {
    const visible = typeof document === "undefined" || document.visibilityState === "visible";
    const sessionIds = visible ? [...this.watched.keys()].sort() : [];
    const last = this.lastViewing?.sessionIds;
    if (last && last.length === sessionIds.length && last.every((id, i) => id === sessionIds[i])) return;
    this.send({ type: "viewing", sessionIds });
  }

  connect(): void {
    this.stopped = false;
    connectionStatus.value = "connecting";
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      const wasReconnect = this.retry > 0;
      this.retry = 0;
      connectionStatus.value = "open";
      if (this.lastViewing) ws.send(JSON.stringify(this.lastViewing));
      if (wasReconnect) this.reconnectHandlers.forEach((h) => h());
    };
    ws.onmessage = (e) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      this.handlers.forEach((h) => h(message));
    };
    ws.onclose = () => {
      connectionStatus.value = "closed";
      if (this.stopped) return;
      const delay = Math.min(10_000, 250 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  disconnect(): void {
    this.stopped = true;
    this.ws?.close();
  }

  send(message: ClientMessage): void {
    if (message.type === "viewing") this.lastViewing = message;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  onMessage(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Called after a dropped connection is re-established (state should be re-fetched). */
  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }
}

function defaultUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
}

export const socket = new Socket();
