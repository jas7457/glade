/**
 * Power and menu bar routes (I-147/I-150), local owner only (mounted behind `localOnly`):
 *
 * - `GET /api/power` → `PowerStatus` (why the Mac is kept awake; also pushed as `power`).
 * - `GET /api/desktop/state?after=<rev>` → `DesktopShellState`, a long-poll for the Mac app's
 *   shell (src-tauri/src/shell_state.rs): at once when `after` is missing or stale, else on the
 *   next change or after ~25 s.
 */
import { Hono } from "hono";
import type { PowerTracker } from "../services/power.js";

export function powerRoutes(power: PowerTracker, waitMs = 25_000): Hono {
  const api = new Hono();
  api.get("/power", (c) => c.json(power.power()));
  api.get("/desktop/state", async (c) => {
    const raw = c.req.query("after");
    const after = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null;
    return c.json(await power.wait(after, waitMs, c.req.raw.signal));
  });
  return api;
}
