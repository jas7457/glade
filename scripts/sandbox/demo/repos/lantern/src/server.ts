import { Hono } from "hono";
import type { LanternConfig } from "./config.js";
import type { Store } from "./store.js";

export function createServer(config: LanternConfig, store: Store): Hono {
  const app = new Hono();

  app.get("/api/checks", (c) =>
    c.json(
      config.checks.map((check) => ({
        id: check.id,
        name: check.name,
        url: check.url,
        uptime24h: store.uptime(check.id, 24),
        last: store.history(check.id, 1)[0] ?? null,
      })),
    ),
  );

  app.get("/api/checks/:id/history", (c) => {
    const id = c.req.param("id");
    if (!config.checks.some((check) => check.id === id)) return c.json({ error: "unknown check" }, 404);
    return c.json(store.history(id, Number(c.req.query("limit") ?? 288)));
  });

  return app;
}
