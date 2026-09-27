/**
 * Agent API (I-037), mounted at `/api/agents`: lets an agent process pi-ui started spawn and talk
 * to sub-agents (the ext-kit agent-teams extension's pi-ui backend calls it). Every request carries
 * `Authorization: Bearer <PI_UI_TOKEN>`; the token identifies the calling session (and so its
 * workspace). Behaviour lives in AppService; see docs/ARCHITECTURE.md → "Agent API".
 */
import { Hono, type Context } from "hono";
import type { CloseAgentRequest, MessageAgentRequest, ReportDoneRequest, Session, SpawnAgentRequest } from "@pi-ui/protocol";
import { HttpError, type AppService } from "../services/app-service.js";

export function createAgentsRoutes(service: AppService): Hono {
  const api = new Hono();

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error("[pi-ui] agent request failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  /** The calling session, from its bearer token. */
  const caller = (c: Context): Session => {
    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    return service.authenticateAgent(match?.[1]);
  };

  api.get("/", (c) => c.json(service.listAgents(caller(c).id)));

  api.post("/spawn", async (c) => {
    const session = caller(c);
    const body = await readBody<SpawnAgentRequest>(c);
    requireString(body.name, "name");
    requireString(body.task, "task");
    for (const key of ["agent", "agentPrompt", "model", "thinking", "keepOpenReason"] as const) optional(body[key], "string", key);
    optional(body.keepOpen, "boolean", "keepOpen");
    if (body.tools !== undefined && (!Array.isArray(body.tools) || !body.tools.every((t) => typeof t === "string"))) {
      throw new HttpError(400, "tools must be an array of strings");
    }
    return c.json(await service.spawnAgent(session.id, body));
  });

  api.post("/message", async (c) => {
    const session = caller(c);
    const body = await readBody<MessageAgentRequest>(c);
    requireString(body.to, "to");
    requireString(body.text, "text");
    service.messageAgent(session.id, body);
    return c.body(null, 204);
  });

  api.post("/close", async (c) => {
    const session = caller(c);
    const body = await readBody<CloseAgentRequest>(c);
    requireString(body.name, "name");
    return c.json(await service.closeAgent(session.id, body.name));
  });

  api.post("/report-done", async (c) => {
    const session = caller(c);
    const body = await readBody<ReportDoneRequest>(c);
    requireString(body.summary, "summary");
    optional(body.keepOpen, "boolean", "keepOpen");
    return c.json(service.reportAgentDone(session.id, body));
  });

  api.notFound((c) => c.json({ error: "Not found" }, 404));
  return api;
}

async function readBody<T>(c: Context): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return body as T;
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} is required`);
}

function optional(value: unknown, type: "string" | "boolean", name: string): void {
  if (value !== undefined && typeof value !== type) throw new HttpError(400, `${name} must be a ${type}`);
}
