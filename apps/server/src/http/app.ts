/**
 * The Hono app: REST API under `/api`, WebSocket push at `/ws`, and (in production) the built
 * web app. Routes are thin; all behaviour lives in {@link AppService}. See the "Server API"
 * table in docs/ARCHITECTURE.md.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  THINKING_LEVELS,
  type CreateChatRequest,
  type CreateProjectRequest,
  type DeepPartial,
  type ModelRef,
  type PromptRequest,
  type Settings,
  type ThinkingLevel,
  type UiResponse,
  type UpdateChatRequest,
  type UpdateProjectRequest,
} from "@pi-ui/protocol";
import { HttpError, type AppService } from "../services/app-service.js";
import { listDirectories } from "../services/fs-browse.js";
import { securityMiddleware, type SecurityOptions } from "./security.js";
import { createWsHandler } from "./ws.js";

export interface CreateAppOptions {
  service: AppService;
  security?: SecurityOptions;
  /** Built web app (`apps/web/dist`). Served with SPA fallback when it exists. */
  staticDir?: string;
}

export function createApp({ service, security, staticDir }: CreateAppOptions) {
  const app = new Hono();
  const nodeWs = createNodeWebSocket({ app });

  app.use("*", securityMiddleware(security));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error("[pi-ui] request failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  app.route("/api", apiRoutes(service));
  app.get("/ws", nodeWs.upgradeWebSocket(createWsHandler(service)));

  if (staticDir && existsSync(join(staticDir, "index.html"))) {
    // serveStatic only accepts roots relative to the working directory.
    const root = relative(process.cwd(), staticDir) || ".";
    app.use("*", serveStatic({ root }));
    const indexHtml = join(staticDir, "index.html");
    app.get("*", async (c, next) => {
      if (c.req.path.startsWith("/api/") || c.req.path === "/api" || c.req.path === "/ws") return next();
      return c.html(await readFile(indexHtml, "utf8"));
    });
  }

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return { app, injectWebSocket: nodeWs.injectWebSocket };
}

function apiRoutes(service: AppService): Hono {
  const api = new Hono();

  // Projects ----------------------------------------------------------------------------------
  api.get("/projects", (c) => c.json(service.listProjects()));
  api.post("/projects", async (c) => {
    const body = await readBody<CreateProjectRequest>(c);
    requireString(body.path, "path");
    optional(body.name, "string", "name");
    return c.json(service.createProject(body));
  });
  api.patch("/projects/:id", async (c) => {
    const body = await readBody<UpdateProjectRequest>(c);
    optional(body.name, "string", "name");
    optional(body.pinned, "boolean", "pinned");
    return c.json(service.updateProject(c.req.param("id"), body));
  });
  api.delete("/projects/:id", async (c) => {
    await service.deleteProject(c.req.param("id"));
    return c.body(null, 204);
  });

  // Chats -------------------------------------------------------------------------------------
  api.get("/chats", (c) => c.json(service.listChats()));
  api.post("/chats", async (c) => {
    const body = await readBody<CreateChatRequest>(c);
    if (body.projectId !== null && typeof body.projectId !== "string") {
      throw new HttpError(400, "projectId must be a string or null");
    }
    optional(body.prompt, "string", "prompt");
    if (body.model != null) requireModelRef(body.model);
    if (body.thinkingLevel != null) requireThinkingLevel(body.thinkingLevel);
    if (body.images !== undefined) requireImages(body.images);
    return c.json(await service.createChat(body));
  });
  api.get("/chats/:id", async (c) => c.json(await service.getChatDetail(c.req.param("id"))));
  api.patch("/chats/:id", async (c) => {
    const body = await readBody<UpdateChatRequest>(c);
    optional(body.title, "string", "title");
    optional(body.pinned, "boolean", "pinned");
    optional(body.archived, "boolean", "archived");
    optional(body.unread, "boolean", "unread");
    return c.json(await service.updateChat(c.req.param("id"), body));
  });
  api.delete("/chats/:id", async (c) => {
    await service.deleteChat(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/chats/:id/prompt", async (c) => {
    const body = await readBody<PromptRequest>(c);
    requireString(body.text, "text", true);
    if (body.images !== undefined) requireImages(body.images);
    if (body.behavior !== undefined && body.behavior !== "steer" && body.behavior !== "followUp") {
      throw new HttpError(400, 'behavior must be "steer" or "followUp"');
    }
    await service.prompt(c.req.param("id"), body);
    return c.body(null, 204);
  });
  api.post("/chats/:id/abort", async (c) => {
    await service.abort(c.req.param("id"));
    return c.body(null, 204);
  });
  api.put("/chats/:id/model", async (c) => {
    const body = await readBody<ModelRef>(c);
    requireModelRef(body);
    await service.setModel(c.req.param("id"), { provider: body.provider, id: body.id });
    return c.body(null, 204);
  });
  api.put("/chats/:id/thinking", async (c) => {
    const body = await readBody<{ level: ThinkingLevel }>(c);
    requireThinkingLevel(body.level);
    await service.setThinkingLevel(c.req.param("id"), body.level);
    return c.body(null, 204);
  });
  api.post("/chats/:id/ui-response", async (c) => {
    const body = await readBody<UiResponse>(c);
    requireString(body.id, "id");
    const ok =
      ("value" in body && typeof body.value === "string") ||
      ("confirmed" in body && typeof body.confirmed === "boolean") ||
      ("cancelled" in body && body.cancelled === true);
    if (!ok) throw new HttpError(400, "ui-response needs value, confirmed or cancelled");
    service.respondToUi(c.req.param("id"), body);
    return c.body(null, 204);
  });

  // Models + settings -------------------------------------------------------------------------
  api.get("/models", async (c) => {
    const refresh = c.req.query("refresh");
    return c.json(await service.listModels(refresh === "1" || refresh === "true"));
  });
  api.get("/settings", (c) => c.json(service.getSettings()));
  api.patch("/settings", async (c) => {
    const body = await readBody<DeepPartial<Settings>>(c);
    return c.json(service.updateSettings(body));
  });

  // Filesystem --------------------------------------------------------------------------------
  api.get("/fs/dirs", async (c) => c.json(await listDirectories(c.req.query("path"))));

  api.notFound((c) => c.json({ error: "Not found" }, 404));
  return api;
}

// ---------------------------------------------------------------------------------------------
// Minimal body validation
// ---------------------------------------------------------------------------------------------

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

function requireString(value: unknown, name: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new HttpError(400, `${name} is required`);
  }
}

function optional(value: unknown, type: "string" | "boolean", name: string): void {
  if (value !== undefined && typeof value !== type) throw new HttpError(400, `${name} must be a ${type}`);
}

function requireModelRef(value: unknown): asserts value is ModelRef {
  const v = value as Partial<ModelRef> | null;
  if (typeof v !== "object" || v === null || typeof v.provider !== "string" || typeof v.id !== "string" || !v.provider || !v.id) {
    throw new HttpError(400, "model must be { provider, id }");
  }
}

function requireThinkingLevel(value: unknown): asserts value is ThinkingLevel {
  if (!(THINKING_LEVELS as readonly unknown[]).includes(value)) {
    throw new HttpError(400, `level must be one of ${THINKING_LEVELS.join(", ")}`);
  }
}

function requireImages(value: unknown): void {
  const ok =
    Array.isArray(value) &&
    value.every(
      (i) =>
        typeof i === "object" &&
        i !== null &&
        typeof (i as Record<string, unknown>).mimeType === "string" &&
        typeof (i as Record<string, unknown>).data === "string",
    );
  if (!ok) throw new HttpError(400, "images must be [{ mimeType, data }]");
}
