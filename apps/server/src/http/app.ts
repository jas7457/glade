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
  MAX_ATTACHMENT_BYTES,
  THINKING_LEVELS,
  WORKTREE_REMOVALS,
  type CheckoutBranchRequest,
  type CreateBranchRequest,
  type CreateProjectRequest,
  type CreateSessionRequest,
  type CreateWorkspaceRequest,
  type DeepPartial,
  type ModelRef,
  type OpenProjectRequest,
  type OpenWorkspaceRequest,
  type PromptRequest,
  type ReorderPinnedWorkspacesRequest,
  type ReorderProjectsRequest,
  type Settings,
  type ShellRequest,
  type ThinkingLevel,
  type UiResponse,
  type UpdateProjectRequest,
  type UpdateSessionRequest,
  type UpdateWorkspaceRequest,
  type WorktreeRemoval,
} from "@glade/protocol";
import { HttpError, type AppService } from "../services/app-service.js";
import type { FolderInfoService } from "../services/folder-info.js";
import { createFolderPicker, FolderPickerUnavailableError, type FolderPicker, type PickFolderOptions } from "../services/folder-picker.js";
import { RevealUnavailableError } from "../services/reveal.js";
import { AttachmentError } from "../services/attachments.js";
import { folderRoutes } from "./folder.js";
import { changesRoutes } from "./changes.js";
import { GitChangesService } from "../services/git-changes.js";
import { searchRoutes } from "./search.js";
import { createAgentsRoutes } from "./agents.js";
import type { SearchService } from "../services/search/search-service.js";
import { securityMiddleware, type SecurityOptions } from "./security.js";
import { createWsHandler } from "./ws.js";
import { loadStaticSnapshot, type StaticFile } from "./static-snapshot.js";

export interface CreateAppOptions {
  service: AppService;
  security?: SecurityOptions;
  /** Built web app (`apps/web/dist`). Served with SPA fallback when it exists. */
  staticDir?: string;
  /**
   * Serve the web app from a copy read into memory at startup instead of the folder (I-082: the
   * desktop app's bundle can be replaced on disk while it runs). Default: read per request.
   */
  snapshotStatic?: boolean;
  /** Native folder dialog (injectable for tests). Default: `osascript` on macOS. */
  pickFolder?: FolderPicker;
  /** Folder-level commands, file search and harness defaults (I-043/I-044/I-050). */
  folderInfo?: FolderInfoService;
  /** Chat search (I-045/I-046); routes are mounted only when given. */
  search?: SearchService;
}

export function createApp({ service, security, staticDir, snapshotStatic = false, pickFolder = createFolderPicker(), folderInfo, search }: CreateAppOptions) {
  const app = new Hono();
  const nodeWs = createNodeWebSocket({ app });

  app.use("*", securityMiddleware(security));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error("[glade] request failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  // Feature routers first: `apiRoutes` ends with a catch-all 404.
  if (folderInfo) app.route("/api", folderRoutes(folderInfo));
  // Changes panel (I-097): git status/diff/revert/commit of a workspace's folder.
  app.route("/api", changesRoutes(service, new GitChangesService({ complete: (prompt, cwd) => service.completeQuick(prompt, cwd) })));
  if (search) app.route("/api", searchRoutes(search));
  // Agent API for sub-agents (I-037): token-authenticated, used by the agent-teams Glade backend.
  app.route("/api/agents", createAgentsRoutes(service, search));
  app.route("/api", apiRoutes(service, pickFolder));
  app.get("/ws", nodeWs.upgradeWebSocket(createWsHandler(service)));

  const snapshot = staticDir && snapshotStatic ? loadStaticSnapshot(staticDir) : null;
  if (snapshot) {
    const isApiPath = (path: string) => path.startsWith("/api/") || path === "/api" || path === "/ws";
    const send = (c: Context, file: StaticFile) => {
      c.header("Content-Type", file.type);
      return c.body(new Uint8Array(file.body));
    };
    app.get("*", async (c, next) => {
      if (isApiPath(c.req.path)) return next();
      const file = snapshot.get(c.req.path);
      if (file) return send(c, file);
      // Missing assets are 404s; everything else is a client route (SPA fallback).
      if (c.req.path.startsWith("/assets/")) return next();
      return send(c, snapshot.index);
    });
  } else if (staticDir) {
    // The built web app may appear (or be rebuilt) after the server starts, e.g. `vite build`
    // while `tsx watch` restarts us, so check for it per request rather than once at startup.
    const indexHtml = join(staticDir, "index.html");
    // serveStatic only accepts roots relative to the working directory.
    const serve = serveStatic({ root: relative(process.cwd(), staticDir) || "." });
    const isApiPath = (path: string) => path.startsWith("/api/") || path === "/api" || path === "/ws";
    app.use("*", async (c, next) => (isApiPath(c.req.path) || !existsSync(indexHtml) ? next() : serve(c, next)));
    app.get("*", async (c, next) => {
      if (isApiPath(c.req.path) || !existsSync(indexHtml)) return next();
      return c.html(await readFile(indexHtml, "utf8"));
    });
  }

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return { app, injectWebSocket: nodeWs.injectWebSocket };
}

function apiRoutes(service: AppService, pickFolder: FolderPicker): Hono {
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
    return c.json(service.updateProject(c.req.param("id"), body));
  });
  api.put("/projects/order", async (c) => {
    const body = await readBody<ReorderProjectsRequest>(c);
    requireIds(body.ids);
    return c.json(service.reorderProjects(body.ids));
  });
  api.post("/projects/:id/open", async (c) => {
    const body = await readBody<OpenProjectRequest>(c);
    await service.openProject(c.req.param("id"), body.app);
    return c.body(null, 204);
  });
  api.get("/projects/:id/git", async (c) => c.json(await service.getProjectGit(c.req.param("id"))));
  api.post("/projects/:id/git/checkout", async (c) => {
    const body = await readBody<CheckoutBranchRequest>(c);
    requireString(body.branch, "branch");
    return c.json(await service.checkoutProjectBranch(c.req.param("id"), body.branch));
  });
  api.post("/projects/:id/git/branch", async (c) => {
    const body = await readBody<CreateBranchRequest>(c);
    requireString(body.name, "name");
    optional(body.checkout, "boolean", "checkout");
    return c.json(await service.createProjectBranch(c.req.param("id"), body.name, body.checkout ?? false));
  });
  api.delete("/projects/:id", async (c) => {
    await service.deleteProject(c.req.param("id"));
    return c.body(null, 204);
  });

  // Workspaces (sidebar rows) ----------------------------------------------------------------
  api.get("/workspaces", (c) => c.json(service.listWorkspaces()));
  api.post("/workspaces", async (c) => {
    const body = await readBody<CreateWorkspaceRequest>(c);
    if (body.projectId !== null && typeof body.projectId !== "string") {
      throw new HttpError(400, "projectId must be a string or null");
    }
    requireNewSession(body);
    optional(body.worktree, "boolean", "worktree");
    optional(body.baseRef, "string", "baseRef");
    optional(body.branch, "string", "branch");
    optional(body.carryChanges, "boolean", "carryChanges");
    if ((body.baseRef !== undefined || body.branch !== undefined || body.carryChanges) && !body.worktree) {
      throw new HttpError(400, "baseRef, branch and carryChanges need worktree: true");
    }
    return c.json(await service.createWorkspace(body));
  });
  api.put("/workspaces/pin-order", async (c) => {
    const body = await readBody<ReorderPinnedWorkspacesRequest>(c);
    if (body.projectId !== null && typeof body.projectId !== "string") {
      throw new HttpError(400, "projectId must be a string or null");
    }
    requireIds(body.ids);
    return c.json(service.reorderPinnedWorkspaces(body.projectId, body.ids));
  });
  api.get("/workspaces/:id", (c) => c.json(service.getWorkspaceDetail(c.req.param("id"))));
  api.patch("/workspaces/:id", async (c) => {
    const body = await readBody<UpdateWorkspaceRequest>(c);
    optional(body.title, "string", "title");
    optional(body.pinned, "boolean", "pinned");
    if (body.layout !== undefined && body.layout !== null && (typeof body.layout !== "object" || Array.isArray(body.layout))) {
      throw new HttpError(400, "layout must be an object or null");
    }
    return c.json(await service.updateWorkspace(c.req.param("id"), body));
  });
  api.post("/workspaces/:id/open", async (c) => {
    const body = await readBody<OpenWorkspaceRequest>(c);
    await service.openWorkspace(c.req.param("id"), body.app);
    return c.body(null, 204);
  });
  api.get("/workspaces/:id/worktree", async (c) => c.json(await service.getWorktreeStatus(c.req.param("id"))));
  api.delete("/workspaces/:id", async (c) => {
    const worktree = c.req.query("worktree");
    if (worktree !== undefined && !WORKTREE_REMOVALS.includes(worktree as WorktreeRemoval)) {
      throw new HttpError(400, `worktree must be one of ${WORKTREE_REMOVALS.join(", ")}`);
    }
    await service.deleteWorkspace(c.req.param("id"), worktree as WorktreeRemoval | undefined);
    return c.body(null, 204);
  });
  api.get("/workspaces/:id/sessions", (c) => c.json(service.listSessions(c.req.param("id"))));
  api.post("/workspaces/:id/sessions", async (c) => {
    const body = await readOptionalBody<CreateSessionRequest>(c);
    requireNewSession(body);
    return c.json(await service.createSession(c.req.param("id"), body));
  });
  /** Legacy alias of `GET /workspaces` (the desktop app's quit check counts busy rows). */
  api.get("/chats", (c) => c.json(service.listWorkspaces()));

  // Sessions (one agent conversation each) ---------------------------------------------------
  api.get("/sessions", (c) => c.json(service.listSessions()));
  api.get("/sessions/:id", async (c) => c.json(await service.getSessionDetail(c.req.param("id"))));
  api.patch("/sessions/:id", async (c) => {
    const body = await readBody<UpdateSessionRequest>(c);
    optional(body.title, "string", "title");
    optional(body.unread, "boolean", "unread");
    if (body.interrupted !== undefined && body.interrupted !== false) {
      throw new HttpError(400, "interrupted can only be set to false");
    }
    return c.json(await service.updateSession(c.req.param("id"), body));
  });
  api.post("/sessions/:id/title/generate", async (c) => c.json(await service.generateSessionTitle(c.req.param("id"))));
  api.delete("/sessions/:id", async (c) => {
    await service.deleteSession(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/sessions/:id/prompt", async (c) => {
    const body = await readBody<PromptRequest>(c);
    requireString(body.text, "text", true);
    if (body.images !== undefined) requireImages(body.images);
    if (body.behavior !== undefined && body.behavior !== "steer" && body.behavior !== "followUp") {
      throw new HttpError(400, 'behavior must be "steer" or "followUp"');
    }
    await service.prompt(c.req.param("id"), body);
    return c.body(null, 204);
  });
  // Files attached by reference (I-090): raw bytes, `?name=` the file name → AttachmentUploadResponse.
  api.post("/sessions/:id/attachments", async (c) => {
    const name = c.req.query("name");
    requireString(name, "name");
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_ATTACHMENT_BYTES) return c.json({ error: "Files can be at most 50 MB" }, 413);
    try {
      return c.json(await service.saveAttachment(c.req.param("id"), name, c.req.raw.body));
    } catch (err) {
      if (err instanceof AttachmentError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });
  api.post("/sessions/:id/abort", async (c) => {
    await service.abort(c.req.param("id"));
    return c.body(null, 204);
  });
  api.post("/sessions/:id/shell", async (c) => {
    const body = await readBody<ShellRequest>(c);
    requireString(body.command, "command");
    if (typeof body.shareWithAgent !== "boolean") throw new HttpError(400, "shareWithAgent must be a boolean");
    return c.json(await service.runShell(c.req.param("id"), { command: body.command, shareWithAgent: body.shareWithAgent }));
  });
  api.post("/sessions/:id/shell/abort", async (c) => {
    await service.abortShell(c.req.param("id"));
    return c.body(null, 204);
  });
  api.put("/sessions/:id/model", async (c) => {
    const body = await readBody<ModelRef>(c);
    requireModelRef(body);
    await service.setModel(c.req.param("id"), { provider: body.provider, id: body.id });
    return c.body(null, 204);
  });
  api.put("/sessions/:id/thinking", async (c) => {
    const body = await readBody<{ level: ThinkingLevel }>(c);
    requireThinkingLevel(body.level);
    await service.setThinkingLevel(c.req.param("id"), body.level);
    return c.body(null, 204);
  });
  api.get("/sessions/:id/commands", async (c) => c.json(await service.listCommands(c.req.param("id"))));
  api.post("/sessions/:id/compact", async (c) => {
    const body = await readOptionalBody<{ instructions?: string }>(c);
    optional(body.instructions, "string", "instructions");
    return c.json(await service.compact(c.req.param("id"), body.instructions));
  });
  api.post("/sessions/:id/export", async (c) => {
    const body = await readOptionalBody<{ reveal?: boolean }>(c);
    optional(body.reveal, "boolean", "reveal");
    return withReveal(c, () => service.exportSession(c.req.param("id"), { reveal: body.reveal }));
  });
  api.post("/sessions/:id/ui-response", async (c) => {
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
  // Installed harnesses, the default first (I-065).
  api.get("/harnesses", (c) => c.json(service.listHarnesses()));
  api.get("/models", async (c) => {
    const refresh = c.req.query("refresh");
    return c.json(await service.listModels(refresh === "1" || refresh === "true"));
  });
  api.get("/settings", (c) => c.json(service.getSettings()));
  // I-121: settings live in glade.db; this is their JSON export (the stored overrides only).
  api.get("/settings/export", (c) => {
    c.header("content-disposition", 'attachment; filename="glade-settings.json"');
    return c.json(service.exportSettings());
  });
  api.patch("/settings", async (c) => {
    const body = await readBody<DeepPartial<Settings>>(c);
    return c.json(service.updateSettings(body));
  });

  // Filesystem --------------------------------------------------------------------------------
  api.post("/fs/pick-folder", async (c) => {
    // The body is optional: `{ prompt?, defaultPath? }`.
    const body = (await c.req.text()).trim() ? await readBody<PickFolderOptions>(c) : {};
    optional(body.prompt, "string", "prompt");
    optional(body.defaultPath, "string", "defaultPath");
    try {
      return c.json(await pickFolder({ prompt: body.prompt, defaultPath: body.defaultPath }));
    } catch (err) {
      if (err instanceof FolderPickerUnavailableError) return c.json({ error: err.message }, 501);
      throw err;
    }
  });

  api.post("/fs/reveal", async (c) => {
    const body = await readBody<{ path: string }>(c);
    requireString(body.path, "path");
    return withReveal(c, async () => {
      await service.revealPath(body.path);
      return null;
    });
  });

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

/** Like {@link readBody}, but an empty body means `{}`. */
async function readOptionalBody<T extends object>(c: Context): Promise<Partial<T>> {
  const text = (await c.req.text()).trim();
  return text ? readBody<Partial<T>>(c) : {};
}

/** Run `fn`; JSON result (204 for null), 501 when Finder reveal isn't available here. */
async function withReveal(c: Context, fn: () => Promise<unknown>): Promise<Response> {
  try {
    const result = await fn();
    return result === null ? c.body(null, 204) : c.json(result);
  } catch (err) {
    if (err instanceof RevealUnavailableError) return c.json({ error: err.message }, 501);
    throw err;
  }
}

function requireString(value: unknown, name: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new HttpError(400, `${name} is required`);
  }
}

function optional(value: unknown, type: "string" | "boolean", name: string): void {
  if (value !== undefined && typeof value !== type) throw new HttpError(400, `${name} must be a ${type}`);
}

function requireIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) {
    throw new HttpError(400, "ids must be an array of strings");
  }
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

/** Optional first prompt / model / thinking level of a new session. */
function requireNewSession(body: Partial<CreateSessionRequest>): void {
  optional(body.prompt, "string", "prompt");
  optional(body.harness, "string", "harness");
  if (body.model != null) requireModelRef(body.model);
  if (body.thinkingLevel != null) requireThinkingLevel(body.thinkingLevel);
  if (body.images !== undefined) requireImages(body.images);
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
