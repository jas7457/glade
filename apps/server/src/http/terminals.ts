/**
 * Terminal tabs (I-187): REST to start/list/close shells and the per-terminal WebSocket
 * (`/ws/terminal/:terminalId`) that streams output and takes input and resizes. Contract in
 * packages/protocol/src/terminal.ts; behaviour in services/terminals.ts.
 *
 * Auth is the app's (http/security.ts): the local owner, or a paired device (bearer token for
 * REST, a one-time `?ticket=` for the socket), the same trust as running agents in a chat.
 */
import { Hono, type Context } from "hono";
import type { WSEvents } from "hono/ws";
import { isTerminalId, TERMINAL_MISSING_CLOSE_CODE, type StartTerminalRequest, type TerminalServerMessage } from "@glade/protocol";
import { TerminalError, type TerminalAttachment, type TerminalService } from "../services/terminals.js";
import type { AuthService } from "../services/auth/auth-service.js";

const OPEN = 1;

export function terminalRoutes(terminals: TerminalService): Hono {
  const api = new Hono();
  const fail = (c: Context, err: unknown) => {
    if (err instanceof TerminalError) return c.json({ error: err.message }, err.status);
    throw err;
  };

  api.get("/workspaces/:id/terminals", async (c) => c.json(await terminals.listWithForeground(c.req.param("id"))));

  api.post("/workspaces/:id/terminals/:terminalId/start", async (c) => {
    const terminalId = c.req.param("terminalId");
    if (!isTerminalId(terminalId)) return c.json({ error: "Invalid terminal id" }, 400);
    const body = (await c.req.json().catch(() => ({}))) as Partial<StartTerminalRequest>;
    try {
      return c.json(await terminals.start(c.req.param("id"), terminalId, { cols: body.cols ?? 80, rows: body.rows ?? 24 }));
    } catch (err) {
      return fail(c, err);
    }
  });

  api.delete("/terminals/:terminalId", (c) => {
    terminals.kill(c.req.param("terminalId"));
    return c.body(null, 204);
  });

  return api;
}

interface RawSocket {
  bufferedAmount?: number;
  terminate?: () => void;
}

/**
 * `/ws/terminal/:terminalId`: attach to a running shell (closes with 4404 when there's none).
 * A paired device's socket is registered with auth, so revoking the device or turning remote
 * access off closes it like the main socket.
 */
export function createTerminalWsHandler(terminals: TerminalService, auth?: AuthService): (c: Context) => WSEvents {
  return (c) => {
    const terminalId = c.req.param("terminalId") ?? "";
    const identity = c.get("identity") ?? { kind: "local" };
    let attachment: TerminalAttachment | null = null;
    let untrack: (() => void) | null = null;
    return {
      onOpen(_event, ws) {
        const raw = ws.raw as RawSocket | undefined;
        if (identity.kind === "remote" && auth) {
          untrack = auth.attachSocket(identity, {
            send: () => {},
            close: (code, reason) => {
              try {
                ws.close(code, reason);
              } catch {
                raw?.terminate?.();
              }
            },
          });
        }
        attachment = terminals.attach(terminalId, {
          send: (message: TerminalServerMessage) => {
            if (ws.readyState === OPEN) ws.send(JSON.stringify(message));
          },
          bufferedAmount: () => raw?.bufferedAmount ?? 0,
        });
        if (!attachment) ws.close(TERMINAL_MISSING_CLOSE_CODE, "No such terminal");
      },
      onMessage(event) {
        if (!attachment) return;
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const m = message as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
        if (m.type === "input" && typeof m.data === "string") attachment.input(m.data);
        else if (m.type === "resize") attachment.resize(Number(m.cols), Number(m.rows));
      },
      onClose() {
        attachment?.detach();
        attachment = null;
        untrack?.();
        untrack = null;
      },
    };
  };
}
