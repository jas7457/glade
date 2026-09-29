/**
 * Build stamp and "is this app behind?" routes (I-149, contract: @glade/protocol version.ts).
 *
 *   GET  /version                → VersionStatus (the last check; never waits for git)
 *   POST /version/check          → VersionStatus after a check (Settings → About's Check Now)
 *   GET  /version/compare?commit → BuildComparison (Connections: another device's build vs. ours)
 */
import { Hono } from "hono";
import type { UpdateChecker } from "../services/update-check.js";

export function versionRoutes(updates: UpdateChecker): Hono {
  const api = new Hono();
  api.get("/version", (c) => c.json(updates.status()));
  api.post("/version/check", async (c) => c.json(await updates.check()));
  api.get("/version/compare", async (c) => {
    const commit = c.req.query("commit") ?? "";
    if (!/^[0-9a-fA-F]{7,40}$/.test(commit)) return c.json({ error: "commit must be a git sha" }, 400);
    return c.json(await updates.compare(commit));
  });
  return api;
}
