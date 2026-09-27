/**
 * Agent API (I-037), mounted at `/api/agents`: lets an agent process Glade started spawn and talk
 * to sub-agents (the ext-kit agent-teams extension's Glade backend calls it). Every request carries
 * `Authorization: Bearer <GLADE_TOKEN>`; the token identifies the calling session (and so its
 * workspace). Behaviour lives in AppService; see docs/ARCHITECTURE.md → "Agent API".
 * `/chats/find|read|open` are the chat tools (I-091, `services/chat-tools.ts`).
 */
import { Hono, type Context } from "hono";
import type {
  CloseAgentRequest,
  FindChatsRequest,
  MessageAgentRequest,
  OpenChatRequest,
  ReadChatRequest,
  ReportDoneRequest,
  Session,
  SpawnAgentRequest,
} from "@glade/protocol";
import { HttpError, type AppService } from "../services/app-service.js";
import { ChatTools } from "../services/chat-tools.js";
import type { SearchService } from "../services/search/search-service.js";

/** `search` powers `/chats/find` (501 without it; read/open work regardless). */
export function createAgentsRoutes(service: AppService, search?: SearchService): Hono {
  const api = new Hono();
  const chats = new ChatTools(service, search ?? null);

  api.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error("[glade] agent request failed:", err);
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

  // Chat tools (I-091) --------------------------------------------------------------------------

  api.post("/chats/find", async (c) => {
    const session = caller(c);
    const body = await readBody<FindChatsRequest>(c);
    requireString(body.query, "query");
    optional(body.limit, "number", "limit");
    optional(body.includeSelf, "boolean", "includeSelf");
    return c.json(await chats.find(session.id, body));
  });

  api.post("/chats/read", async (c) => {
    caller(c);
    const body = await readBody<ReadChatRequest>(c);
    requireString(body.id, "id");
    optional(body.limit, "number", "limit");
    return c.json(await chats.read(body));
  });

  api.post("/chats/open", async (c) => {
    caller(c);
    const body = await readBody<OpenChatRequest>(c);
    requireString(body.id, "id");
    return c.json(chats.open(body.id));
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

function optional(value: unknown, type: "string" | "boolean" | "number", name: string): void {
  if (value !== undefined && typeof value !== type) throw new HttpError(400, `${name} must be a ${type}`);
}
