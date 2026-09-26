/**
 * WebSocket push channel (`/ws`). Each connection receives every {@link ServerMessage} the
 * AppService broadcasts, and reports which chat it's showing so finished runs there aren't
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
    let viewing: string | null = null;

    const setViewing = (chatId: string | null) => {
      if (chatId === viewing) return;
      if (viewing) service.setViewing(viewing, false);
      viewing = chatId;
      if (viewing) service.setViewing(viewing, true);
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
        const m = message as Partial<Record<keyof ClientMessage, unknown>>;
        if (m.type === "viewing" && (typeof m.chatId === "string" || m.chatId === null)) {
          setViewing(m.chatId);
        }
      },
      onClose() {
        unsubscribe?.();
        unsubscribe = null;
        setViewing(null);
      },
      onError() {
        // `close` follows; cleanup happens there.
      },
    };
  };
}
