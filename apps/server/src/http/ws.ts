/**
 * WebSocket push channel (`/ws`). A connection starts in the original mode: it receives every
 * {@link ServerMessage} the AppService broadcasts, untagged. Its first `subscribe` switches it to
 * sequenced sync (protocol 2, I-122; `services/sync/hub.ts`): scoped subscriptions with replay or
 * snapshot, `seq`-tagged pushes in batches, and pings. Either way it reports which sessions it's
 * showing, so finished runs there aren't marked unread.
 *
 * I-125: remote sockets (opened with a `?ticket=`, checked by the security middleware) are tagged
 * with their device and closed at once when it's revoked (4401) or remote access is turned off
 * (4403); local-owner sockets also get `pairing_pending` pushes.
 */
import type { Context } from "hono";
import type { WSContext, WSEvents } from "hono/ws";
import { SYNC_PROTOCOL, type ServerMessage } from "@glade/protocol";
import { VERSION } from "../config.js";
import type { AppService } from "../services/app-service.js";
import type { SyncClient } from "../services/sync/hub.js";
import type { AuthService } from "../services/auth/auth-service.js";

const OPEN = 1;

/** The `ws` socket behind hono's context (for its send buffer and terminate). */
interface RawSocket {
  bufferedAmount?: number;
  terminate?: () => void;
}

export function createWsHandler(service: AppService, auth?: AuthService): (c: Context) => WSEvents {
  return (c) => {
    const identity = c.get("identity") ?? { kind: "local" };
    let detach: (() => void) | null = null;
    let unsubscribe: (() => void) | null = null;
    let viewing = new Set<string>();
    let sync: SyncClient | null = null;

    /** Replace this connection's on-screen sessions (diffed, so counts stay balanced). */
    const setViewing = (sessionIds: Iterable<string>) => {
      const next = new Set(sessionIds);
      for (const id of viewing) if (!next.has(id)) service.setViewing(id, false);
      for (const id of next) if (!viewing.has(id)) service.setViewing(id, true);
      viewing = next;
    };

    /** Switch to sequenced sync (the first `subscribe`). */
    const startSync = (ws: WSContext): SyncClient => {
      const raw = ws.raw as RawSocket | undefined;
      const client = service.sync.connect({
        send: (data) => {
          if (ws.readyState === OPEN) ws.send(data);
        },
        bufferedAmount: () => raw?.bufferedAmount ?? 0,
        close: () => (raw?.terminate ? raw.terminate() : ws.close()),
      });
      // The sync client receives the app's pushes itself from now on.
      unsubscribe?.();
      unsubscribe = null;
      return client;
    };

    return {
      onOpen(_event, ws) {
        const send = (message: ServerMessage) => {
          if (ws.readyState === OPEN) ws.send(JSON.stringify(message));
        };
        send({ type: "hello", version: VERSION, protocol: SYNC_PROTOCOL, environmentId: service.environment.id });
        unsubscribe = service.subscribe(send);
        const usage = service.getUsageLimits();
        if (usage) send({ type: "usage_limits", usage });
        const raw = ws.raw as RawSocket | undefined;
        detach =
          auth?.attachSocket(identity, {
            send,
            close: (code, reason) => {
              try {
                ws.close(code, reason);
              } catch {
                raw?.terminate?.();
              }
            },
          }) ?? null;
      },
      onMessage(event, ws) {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        sync?.seen();
        const m = message as { type?: unknown; sessionIds?: unknown; scope?: unknown; sessionId?: unknown; afterSeq?: unknown; t?: unknown };
        const afterSeq = typeof m.afterSeq === "number" ? m.afterSeq : undefined;
        switch (m.type) {
          case "viewing":
            if (Array.isArray(m.sessionIds) && m.sessionIds.every((id) => typeof id === "string")) setViewing(m.sessionIds as string[]);
            return;
          case "subscribe":
            sync ??= startSync(ws);
            if (m.scope === "shell") sync.subscribeShell(afterSeq);
            else if (m.scope === "session" && typeof m.sessionId === "string") void sync.subscribeSession(m.sessionId, afterSeq);
            return;
          case "unsubscribe":
            if (m.scope === "session" && typeof m.sessionId === "string") sync?.unsubscribeSession(m.sessionId);
            return;
          case "ping":
            if (sync) sync.ping(typeof m.t === "number" ? m.t : Date.now());
            else if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: "pong", t: m.t }));
            return;
          default:
            return;
        }
      },
      onClose() {
        detach?.();
        detach = null;
        unsubscribe?.();
        unsubscribe = null;
        sync?.dispose();
        sync = null;
        setViewing([]);
      },
      onError() {
        // `close` follows; cleanup happens there.
      },
    };
  };
}
