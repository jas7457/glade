/**
 * Search routes (I-045/I-046), mounted under `/api` next to the main API:
 *   GET  /search?q=&limit=   → SearchResponse (full-text hits with snippets)
 *   POST /search/ask         → AskResponse (AskRequest `{ query, limit? }`; fast-model chat finder)
 * Thin: behaviour lives in `services/search/search-service.ts`.
 */
import { Hono } from "hono";
import type { AskRequest } from "@pi-ui/protocol";
import type { SearchService } from "../services/search/search-service.js";

function clampLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), max) : fallback;
}

export function searchRoutes(search: SearchService): Hono {
  const api = new Hono();
  api.get("/search", async (c) => {
    const q = c.req.query("q") ?? "";
    return c.json(await search.search(q.slice(0, 500), clampLimit(c.req.query("limit"), 20, 100)));
  });
  api.post("/search/ask", async (c) => {
    let body: Partial<AskRequest>;
    try {
      body = (await c.req.json()) as Partial<AskRequest>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body?.query !== "string" || !body.query.trim()) return c.json({ error: "query must be a non-empty string" }, 400);
    return c.json(await search.ask(body.query.slice(0, 1000), clampLimit(body.limit, 3, 10)));
  });
  return api;
}
