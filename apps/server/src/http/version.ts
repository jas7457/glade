/**
 * Build stamp and "is this app behind?" routes (I-149, contract: @glade/protocol version.ts).
 *
 *   GET  /version                → VersionStatus (the last check; never waits for git)
 *   POST /version/check          → VersionStatus after a check (Settings → General's Check Now)
 *   GET  /version/compare?commit → BuildComparison (Connections: another device's build vs. ours)
 *
 * Update Now (I-154), local owner only (`localOnly` on `/api/version/update*` in app.ts):
 *   GET  /version/update         → UpdateJobStatus
 *   POST /version/update         → UpdateJobStatus (started), 409 `{ error }` when it can't start
 *   POST /version/update/cancel  → UpdateJobStatus, 409 `{ error }` when there's nothing to cancel / too late
 */
import { Hono } from "hono";
import type { UpdateChecker } from "../services/update-check.js";
import type { UpdateJob } from "../services/update-job.js";

export function versionRoutes(updates: UpdateChecker, job?: UpdateJob): Hono {
  const api = new Hono();
  if (job) {
    api.get("/version/update", (c) => c.json(job.status()));
    api.post("/version/update", (c) => {
      try {
        return c.json(job.start());
      } catch (err) {
        return c.json({ error: (err as Error).message }, 409);
      }
    });
    api.post("/version/update/cancel", (c) => {
      try {
        return c.json(job.cancel());
      } catch (err) {
        return c.json({ error: (err as Error).message }, 409);
      }
    });
  }
  api.get("/version", (c) => c.json(updates.status()));
  api.post("/version/check", async (c) => c.json(await updates.check()));
  api.get("/version/compare", async (c) => {
    const commit = c.req.query("commit") ?? "";
    if (!/^[0-9a-fA-F]{7,40}$/.test(commit)) return c.json({ error: "commit must be a git sha" }, 400);
    return c.json(await updates.compare(commit));
  });
  return api;
}
