import { signal } from "@preact/signals";
import type { ClientMessage, ServerMessage } from "@glade/protocol";

export type { ClientMessage };

export type SocketStatus = "connecting" | "open" | "closed";

type Handler = (message: ServerMessage) => void;

/** Nothing received for this long (the server pings every 20 s): the connection is dead (I-122). */
const DEAD_AFTER_MS = 45_000;

/**
 * Auto-reconnecting WebSocket to one environment's `/ws` (I-123: one per environment; `socket`
 * below is the local environment's). The server pushes {@link ServerMessage}s; the client
 * reports which sessions are on screen and subscribes to sync scopes (I-122, `state/sync.ts`).
 * Answers the server's pings and drops a connection that went silent.
 */
export class Socket {
  private ws: WebSocket | null = null;
  private readonly handlers = new Set<Handler>();
  private readonly reconnectHandlers = new Set<() => void>();
  private readonly openHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<() => void>();
  private lastMessageAt = 0;
  private deadTimer: ReturnType<typeof setInterval> | null = null;
  private retry = 0;
  private lastViewing: Extract<ClientMessage, { type: "viewing" }> | null = null;
  /** Sessions shown by mounted views (a count, since several views may show the same one). */
  private readonly watched = new Map<string, number>();
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** This connection's state. */
  readonly status = signal<SocketStatus>("connecting");

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
    this.status.value = "connecting";
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      const wasReconnect = this.retry > 0;
      this.retry = 0;
      this.lastMessageAt = Date.now();
      this.status.value = "open";
      if (this.lastViewing) ws.send(JSON.stringify(this.lastViewing));
      this.openHandlers.forEach((h) => h());
      if (wasReconnect) this.reconnectHandlers.forEach((h) => h());
    };
    ws.onmessage = (e) => {
      this.lastMessageAt = Date.now();
      let message: ServerMessage;
      try {
        message = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "ping") {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong", t: message.t }));
        return;
      }
      this.handlers.forEach((h) => h(message));
    };
    ws.onclose = () => this.closed(ws);
    this.deadTimer ??= setInterval(() => this.checkAlive(), 5_000);
  }

  /** The connection is gone (closed, or found dead): reconnect with backoff. */
  private closed(ws: WebSocket): void {
    if (this.ws !== ws) return;
    ws.onopen = ws.onmessage = ws.onclose = null;
    this.ws = null;
    this.status.value = "closed";
    this.closeHandlers.forEach((h) => h());
    if (this.stopped) return;
    const delay = Math.min(10_000, 250 * 2 ** this.retry++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }

  /** A socket that received nothing (not even a ping) for a while is dead: drop it now. */
  private checkAlive(now = Date.now()): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || now - this.lastMessageAt < DEAD_AFTER_MS) return;
    this.drop();
  }

  /** Close the current connection at once and reconnect (dead socket; tests). */
  drop(): void {
    const ws = this.ws;
    if (!ws) return;
    this.closed(ws);
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.deadTimer) clearInterval(this.deadTimer);
    this.deadTimer = null;
    const ws = this.ws;
    if (ws) {
      this.closed(ws);
      ws.close();
    }
  }

  send(message: ClientMessage): void {
    if (message.type === "viewing") this.lastViewing = message;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  onMessage(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Called whenever a connection opens (the first one too). */
  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  /** Called whenever the connection is lost. */
  onClose(handler: () => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** Called after a dropped connection is re-established. */
  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }
}

function defaultUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}/ws`;
}

/** The socket URL of an environment from its API base: `http://h:1/api` → `ws://h:1/ws`. */
export function wsUrlFromApiBase(apiBase: string): string {
  const u = new URL(apiBase);
  const root = u.pathname.replace(/\/?api\/?$/, "");
  return `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}${root}/ws`;
}

/** The local environment's socket (the page-origin server). Connected by its environment. */
export const socket = new Socket();
/** The local socket's state (kept for existing readers). */
export const connectionStatus = socket.status;
