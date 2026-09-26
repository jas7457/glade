/**
 * WebSocket push channel (`/ws`). Each connection receives every {@link ServerMessage} the
 * AppService broadcasts, and reports which sessions it's showing so finished runs there aren't
 * marked unread.
 */
import type { Context } from "hono";
import type { WSEvents } from "hono/ws";
import type { ClientMessage, ServerMessage } from "@pi-ui/protocol";
import { VERSION } from "../config.js";
import type { AppService } from "../services/app-service.js";

const OPEN = 1;

export function createWsHandler(service: AppService): (c: Context) => WSEvents {
  return () => {
    let unsubscribe: (() => void) | null = null;
    let viewing = new Set<string>();

    /** Replace this connection's on-screen sessions (diffed, so counts stay balanced). */
    const setViewing = (sessionIds: Iterable<string>) => {
      const next = new Set(sessionIds);
      for (const id of viewing) if (!next.has(id)) service.setViewing(id, false);
      for (const id of next) if (!viewing.has(id)) service.setViewing(id, true);
      viewing = next;
    };

    return {
      onOpen(_event, ws) {
        const send = (message: ServerMessage) => {
          if (ws.readyState === OPEN) ws.send(JSON.stringify(message));
        };
        send({ type: "hello", version: VERSION });
        unsubscribe = service.subscribe(send);
        const usage = service.getUsageLimits();
        if (usage) send({ type: "usage_limits", usage });
      },
      onMessage(event) {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const m = message as { type?: unknown; sessionIds?: unknown };
        if (m.type === "viewing" && Array.isArray(m.sessionIds) && m.sessionIds.every((id) => typeof id === "string")) {
          setViewing(m.sessionIds as ClientMessage["sessionIds"]);
        }
      },
      onClose() {
        unsubscribe?.();
        unsubscribe = null;
        setViewing([]);
      },
      onError() {
        // `close` follows; cleanup happens there.
      },
    };
  };
}
