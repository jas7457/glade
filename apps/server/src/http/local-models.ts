/**
 * Local models routes (I-196, `@glade/protocol` `local-models.ts`):
 *
 *   GET  /local-models[?refresh=1]  → LocalModelsState
 *   POST /local-models/load         { model, contextLength? } → LocalModelsState
 *   POST /local-models/unload       { model }                 → LocalModelsState
 *
 * Not host-only: paired devices (iPhone, another Mac) load and unload models on this Mac; that's
 * the point. Errors: 400 bad body, 404 unknown model, 409 already loaded / not loaded / the
 * server's model limit, 502 the model server failed or isn't reachable.
 *
 * `contextLength` is accepted (validated) but llama-server's router can't apply it per load (its
 * load API takes only the model); the context comes from the router's `-c` or the model's preset.
 */
import { Hono, type Context } from "hono";
import type { LoadLocalModelRequest, UnloadLocalModelRequest } from "@glade/protocol";
import { LocalModelsError } from "../services/local-models/backend.js";
import type { LocalModelsService } from "../services/local-models/service.js";

export function localModelsRoutes(localModels: LocalModelsService): Hono {
  const api = new Hono();

  api.get("/local-models", async (c) => {
    const refresh = c.req.query("refresh");
    return c.json(await localModels.get(refresh === "1" || refresh === "true"));
  });

  api.post("/local-models/load", async (c) => {
    const body = await readBody<LoadLocalModelRequest>(c);
    if (body instanceof Response) return body;
    if (typeof body.model !== "string" || !body.model.trim()) return c.json({ error: "model is required" }, 400);
    const ctx = body.contextLength;
    if (ctx !== undefined && ctx !== null && (typeof ctx !== "number" || !Number.isSafeInteger(ctx) || ctx <= 0)) {
      return c.json({ error: "contextLength must be a positive integer" }, 400);
    }
    const model = body.model;
    return act(c, () => localModels.load(model, typeof ctx === "number" ? { contextLength: ctx } : {}));
  });

  api.post("/local-models/unload", async (c) => {
    const body = await readBody<UnloadLocalModelRequest>(c);
    if (body instanceof Response) return body;
    if (typeof body.model !== "string" || !body.model.trim()) return c.json({ error: "model is required" }, 400);
    const model = body.model;
    return act(c, () => localModels.unload(model));
  });

  return api;
}

async function act(c: Context, fn: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json(await fn());
  } catch (err) {
    if (err instanceof LocalModelsError) return c.json({ error: err.message }, err.status);
    throw err;
  }
}

async function readBody<T>(c: Context): Promise<Partial<T> | Response> {
  try {
    const body: unknown = await c.req.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) return body as Partial<T>;
  } catch {
    /* below */
  }
  return c.json({ error: "Request body must be a JSON object" }, 400);
}
