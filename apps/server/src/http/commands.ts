/**
 * Idempotent commands (I-122). A mutating request may carry a client `commandId` (the
 * `X-Glade-Command-Id` header, or a `commandId` field in its JSON body). The first request with
 * an id runs and its response is stored in `command_receipts` (a day); a retry with the same id —
 * e.g. after the connection dropped before the answer arrived — gets the stored response instead
 * of running again. While the first one still runs here, the retry waits for it; one still running
 * in another server answers 409. Failed requests (4xx/5xx) are forgotten, so a retry runs again.
 */
import type { MiddlewareHandler } from "hono";
import { COMMAND_ID_HEADER } from "@glade/protocol";
import type { Store } from "../store/store.js";

const MAX_ID_LENGTH = 200;

export function commandIds(store: () => Store): MiddlewareHandler {
  const running = new Map<string, Promise<void>>();
  return async (c, next) => {
    let id = c.req.header(COMMAND_ID_HEADER);
    if (!id && c.req.header("content-type")?.includes("application/json")) {
      try {
        const body = (await c.req.json()) as { commandId?: unknown } | null;
        if (body && typeof body.commandId === "string") id = body.commandId;
      } catch {
        /* the route reports bad JSON */
      }
    }
    if (!id) return next();
    if (id.length > MAX_ID_LENGTH) return c.json({ error: "commandId is too long" }, 400);
    const route = `${c.req.method} ${c.req.path}`;
    // A retry while the first request still runs in this server: wait for it.
    const inFlight = running.get(id);
    if (inFlight) await inFlight.catch(() => {});
    const receipt = store().beginCommand(id, route);
    if (receipt.state === "done") {
      return new Response(receipt.body, {
        status: receipt.status,
        headers: { ...(receipt.body !== null ? { "content-type": "application/json" } : {}), "x-glade-command-replayed": "1" },
      });
    }
    if (receipt.state === "pending") return c.json({ error: "This request is still being handled" }, 409);
    if (receipt.state === "conflict") return c.json({ error: `commandId was already used for ${receipt.route}` }, 409);
    let done!: () => void;
    running.set(id, new Promise<void>((r) => (done = r)));
    try {
      await next();
      const res = c.res;
      if (res.status >= 200 && res.status < 300) {
        const body = res.status === 204 || !res.body ? null : await res.clone().text();
        store().finishCommand(id, res.status, body);
      } else {
        store().dropCommand(id);
      }
    } catch (err) {
      store().dropCommand(id);
      throw err;
    } finally {
      running.delete(id);
      done();
    }
  };
}
