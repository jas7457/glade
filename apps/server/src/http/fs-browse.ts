/**
 * Folder browser routes (I-124), mounted under `/api` by `createApp`:
 *
 *   GET  /fs/browse?path=&hidden=1   → FsBrowseResult (directories only; `~`/empty = home)
 *   POST /fs/mkdir {path}            → FsBrowseEntry (New Folder)
 *
 * Limited to the host user's home folder and `/Volumes` (403 outside). See services/fs-browse.ts.
 */
import { Hono, type Context } from "hono";
import { FsBrowseError, FsBrowseService } from "../services/fs-browse.js";

const truthy = (v: string | undefined) => v === "1" || v === "true";

export function fsBrowseRoutes(service: FsBrowseService = new FsBrowseService()): Hono {
  const api = new Hono();
  api.get("/fs/browse", (c) => handle(c, () => service.browse(c.req.query("path"), { hidden: truthy(c.req.query("hidden")) })));
  api.post("/fs/mkdir", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Request body must be JSON" }, 400);
    }
    const path = (body as { path?: unknown } | null)?.path;
    if (typeof path !== "string" || !path.trim()) return c.json({ error: "path is required" }, 400);
    return handle(c, () => service.mkdir(path));
  });
  return api;
}

async function handle(c: Context, fn: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json(await fn());
  } catch (err) {
    if (err instanceof FsBrowseError) return c.json({ error: err.message }, err.status);
    throw err;
  }
}
