/**
 * `/api/auth/*` (I-125/I-126; contract: packages/protocol/src/auth.ts). The host's own endpoints
 * (remote switch, invites, pending pairings, devices, audit) are local-owner only; `pair` is for
 * clients without a token (remote access on, rate-limited); `me` and `ws-ticket` need a device
 * token. All behaviour lives in {@link AuthService}; its `AuthError`s become `{ code, error }` in
 * app.ts's error handler.
 */
import { Hono, type Context } from "hono";
import type { PairRequest } from "@glade/protocol";
import { AuthError, type AuthService } from "../services/auth/auth-service.js";
import type { RemoteTransport } from "../services/transports/manager.js";
import { localOnly, requestMeta } from "./security.js";

/** `remote`: the transport (I-127); without one the switch is just the database flag (tests). */
export function authRoutes(auth: AuthService, remote?: RemoteTransport): Hono {
  const api = new Hono();

  // Paired devices (bearer) --------------------------------------------------------------------
  const device = (c: Context) => {
    const identity = c.get("identity");
    return identity.kind === "remote" ? identity.device : null;
  };
  api.get("/me", (c) => {
    const d = device(c);
    if (!d) return c.json({ code: "not_a_device", error: "Only paired devices have a device identity." }, 400);
    return c.json(auth.me(d, requestMeta(c)));
  });
  api.post("/ws-ticket", (c) => {
    const d = device(c);
    if (!d) return c.json({ code: "not_a_device", error: "The host's own clients connect without a ticket." }, 400);
    return c.json(auth.issueTicket(d));
  });

  // Clients pairing (no token yet; the security middleware lets only this through) --------------
  api.post("/pair", async (c) => {
    const meta = requestMeta(c);
    auth.checkPairRate(meta.address);
    const body = await readBody<PairRequest>(c);
    return c.json(await auth.pair(body, meta, c.req.raw.signal));
  });

  // The host itself -----------------------------------------------------------------------------
  api.use("/remote", localOnly);
  api.use("/invites/*", localOnly);
  api.use("/invites", localOnly);
  api.use("/pending", localOnly);
  api.use("/pending/*", localOnly);
  api.use("/devices", localOnly);
  api.use("/devices/*", localOnly);
  api.use("/audit", localOnly);
  api.use("/discover", localOnly);

  api.get("/remote", async (c) => {
    if (!remote) return c.json(auth.remoteState());
    await remote.refresh().catch(() => {});
    return c.json(remote.withStatus(auth.remoteState()));
  });
  api.patch("/remote", async (c) => {
    const body = await readBody<{ enabled?: unknown }>(c);
    if (typeof body.enabled !== "boolean") return c.json({ code: "invalid_request", error: "enabled must be a boolean" }, 400);
    const enabled = body.enabled;
    if (!remote) return c.json(auth.setRemoteEnabled(enabled, requestMeta(c)));
    await remote.setEnabled(enabled, () => void auth.setRemoteEnabled(enabled, requestMeta(c)));
    return c.json(remote.withStatus(auth.remoteState()));
  });
  // Glade hosts on the tailnet, for "Connect to Environment" (I-127).
  api.get("/discover", async (c) => c.json(remote ? await remote.discover() : []));

  api.post("/invites", (c) => c.json(auth.createInvite()));
  api.delete("/invites/current", (c) => {
    auth.cancelInvite();
    return c.body(null, 204);
  });

  api.get("/pending", (c) => c.json(auth.listPending()));
  api.post("/pending/:id", async (c) => {
    const body = await readBody<{ allow?: unknown }>(c);
    if (typeof body.allow !== "boolean") return c.json({ code: "invalid_request", error: "allow must be a boolean" }, 400);
    if (!auth.answerPending(c.req.param("id"), body.allow)) return c.json({ code: "not_found", error: "That request is no longer waiting." }, 404);
    return c.body(null, 204);
  });

  api.get("/devices", (c) => c.json(auth.listDevices()));
  api.patch("/devices/:id", async (c) => {
    const body = await readBody<{ name?: unknown }>(c);
    return c.json(auth.renameDevice(c.req.param("id"), body.name));
  });
  api.delete("/devices/:id", (c) => {
    if (!auth.revokeDevice(c.req.param("id"))) return c.json({ code: "not_found", error: "No such device" }, 404);
    return c.body(null, 204);
  });
  api.delete("/devices", (c) => {
    auth.revokeAll();
    return c.body(null, 204);
  });

  api.get("/audit", (c) => c.json(auth.listAudit(Number(c.req.query("limit") ?? 100))));

  api.notFound((c) => c.json({ error: "Not found" }, 404));
  return api;
}

async function readBody<T>(c: Context): Promise<Partial<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AuthError(400, "invalid_request", "Request body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AuthError(400, "invalid_request", "Request body must be a JSON object");
  return body as Partial<T>;
}
