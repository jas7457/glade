/**
 * The Hono app: REST API under `/api`, WebSocket push at `/ws`, and (in production) the built
 * web app. Routes are thin; all behaviour lives in {@link AppService}. See the "Server API"
 * table in docs/ARCHITECTURE.md.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { Hono, type Context } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import {
  MAX_ATTACHMENT_BYTES,
  THINKING_LEVELS,
  WORKTREE_REMOVALS,
  type CheckoutBranchRequest,
  type CreateBranchRequest,
  type CreateFolderRequest,
  type CreateProjectRequest,
  type CreateSessionRequest,
  type CreateWorkspaceRequest,
  type DeepPartial,
  type ModelRef,
  type OpenProjectRequest,
  type OpenWorkspaceRequest,
  type PromptRequest,
  type ReorderFoldersRequest,
  type ReorderPinnedWorkspacesRequest,
  type ReorderProjectsRequest,
  type Settings,
  type ShellRequest,
  type SideQuestionRequest,
  type ThinkingLevel,
  type UiResponse,
  type UpdateFolderRequest,
  type UpdateProjectRequest,
  type UpdateEnvironmentRequest,
  type UpdateSessionRequest,
  type UpdateWorkspaceRequest,
  type WorktreeRemoval,
} from "@glade/protocol";
import { HttpError, type AppService } from "../services/app-service.js";
import type { FolderInfoService } from "../services/folder-info.js";
import { createFolderPicker, FolderPickerUnavailableError, type FolderPicker, type PickFolderOptions } from "../services/folder-picker.js";
import { RevealUnavailableError } from "../services/reveal.js";
import { AttachmentError } from "../services/attachments.js";
import { MAX_ENVIRONMENT_NAME } from "../services/environment.js";
import { folderRoutes } from "./folder.js";
import { changesRoutes } from "./changes.js";
import { GitChangesService } from "../services/git-changes.js";
import { searchRoutes } from "./search.js";
import { createAgentsRoutes } from "./agents.js";
import type { SearchService } from "../services/search/search-service.js";
import { isLocal, localOnly, securityMiddleware } from "./security.js";
import { authRoutes } from "./auth.js";
import { blobRoutes } from "./blobs.js";
import { AuthError, AuthService } from "../services/auth/auth-service.js";
import type { RemoteTransport } from "../services/transports/manager.js";
import { createWsHandler } from "./ws.js";
import { commandIds } from "./commands.js";
import { loadStaticSnapshot, type StaticFile } from "./static-snapshot.js";
import { fsBrowseRoutes } from "./fs-browse.js";
import { powerRoutes } from "./power.js";
import type { PowerTracker } from "../services/power.js";
import { versionRoutes } from "./version.js";
import { UpdateChecker } from "../services/update-check.js";
import { UPDATE_UNAVAILABLE_DEV, UpdateJob } from "../services/update-job.js";
import { TerminalService } from "../services/terminals.js";
import { createTerminalWsHandler, terminalRoutes } from "./terminals.js";

export interface CreateAppOptions {
  service: AppService;
  /**
   * Device auth and pairing (I-125). Default: one on the service's store with no remote
   * addresses (tests).
   */
  auth?: AuthService;
  /** Remote access transport (I-127: Tailscale). None in tests: the switch is just the flag. */
  remote?: RemoteTransport;
  /** Ports whose loopback origins are this server's own (see http/security.ts). */
  ownPorts?: () => number[];
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
  /** Keeping the Mac awake + menu bar state (I-147/I-150); routes are mounted only when given. */
  power?: PowerTracker;
  /** Build stamp + behind check (I-149). Default: one on the service's build that isn't started (tests). */
  updates?: UpdateChecker;
  /** Update Now (I-154). Default: one that isn't available (tests, like `pnpm dev`). */
  updateJob?: UpdateJob;
  /** Terminal tabs (I-187). Default: node-pty shells in the workspaces' folders. */
  terminals?: TerminalService;
}

export function createApp({ service, auth: givenAuth, remote, ownPorts, staticDir, snapshotStatic = false, pickFolder = createFolderPicker(), folderInfo, search, updates, updateJob, power, terminals: givenTerminals }: CreateAppOptions) {
  const app = new Hono();
  const nodeWs = createNodeWebSocket({ app });

  const auth =
    givenAuth ??
    new AuthService({
      db: service.store.db,
      environmentId: service.environment.id,
      environmentName: () => service.getEnvironment().name,
      addresses: () => [],
    });
  app.use("*", securityMiddleware({ auth, ownPorts }));

  app.onError((err, c) => {
    if (err instanceof AuthError) return c.json({ code: err.code, error: err.message }, err.status);
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error("[glade] request failed:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  });

  // Feature routers first: `apiRoutes` ends with a catch-all 404.
  if (folderInfo) app.route("/api", folderRoutes(folderInfo));
  // Changes panel (I-097): git status/diff/revert/commit of a workspace's folder.
  app.route("/api", changesRoutes(service, new GitChangesService({ complete: (prompt, cwd) => service.completeQuick(prompt, cwd) })));
  if (search) app.route("/api", searchRoutes(search));
  // Device auth and pairing (I-125/I-126).
  app.route("/api/auth", authRoutes(auth, remote));
  // Agent API for sub-agents (I-037): token-authenticated, used by the agent-teams Glade backend.
  // Agents run on the host: remote devices can't use it (I-125).
  app.use("/api/agents/*", localOnly);
  app.route("/api/agents", createAgentsRoutes(service, search));
  // Folder browser (I-124): directories in the home folder and /Volumes, New Folder.
  app.route("/api", fsBrowseRoutes());
  if (power) {
    app.use("/api/power", localOnly);
    app.use("/api/desktop/*", localOnly);
    app.route("/api", powerRoutes(power));
  }
  // Build stamp and "is this app behind?" (I-149).
  // Update Now (I-154): local owner only.
  app.use("/api/version/update", localOnly);
  app.use("/api/version/update/*", localOnly);
  app.route(
    "/api",
    versionRoutes(
      updates ?? new UpdateChecker({ build: () => service.environment.build() }),
      updateJob ?? new UpdateJob({ build: () => service.environment.build(), unavailableReason: UPDATE_UNAVAILABLE_DEV }),
    ),
  );
  // Image files (I-157): content-addressed, immutable; same auth as other API reads.
  app.route("/api", blobRoutes(service.store.blobs));
  // Terminal tabs (I-187): shells in a workspace's folder; closed with their tab or workspace.
  const terminals = givenTerminals ?? new TerminalService({ cwdOf: (id) => service.store.getWorkspace(id)?.cwd ?? null });
  service.subscribe(
    (message) => {
      if (message.type === "workspace_removed") terminals.killWorkspace(message.workspaceId);
    },
    { internal: true },
  );
  app.route("/api", terminalRoutes(terminals));
  app.route("/api", apiRoutes(service, pickFolder));
  app.get("/ws", nodeWs.upgradeWebSocket(createWsHandler(service, auth)));
  app.get("/ws/terminal/:terminalId", nodeWs.upgradeWebSocket(createTerminalWsHandler(terminals, auth)));

  const snapshot = staticDir && snapshotStatic ? loadStaticSnapshot(staticDir) : null;
  if (snapshot) {
    const isApiPath = (path: string) => path.startsWith("/api/") || path === "/api" || path === "/ws" || path.startsWith("/ws/");
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
    const isApiPath = (path: string) => path.startsWith("/api/") || path === "/api" || path === "/ws" || path.startsWith("/ws/");
    app.use("*", async (c, next) => (isApiPath(c.req.path) || !existsSync(indexHtml) ? next() : serve(c, next)));
    app.get("*", async (c, next) => {
      if (isApiPath(c.req.path) || !existsSync(indexHtml)) return next();
      return c.html(await readFile(indexHtml, "utf8"));
    });
  }

  app.notFound((c) => c.json({ error: "Not found" }, 404));

  return { app, injectWebSocket: nodeWs.injectWebSocket, auth, terminals };
}

function apiRoutes(service: AppService, pickFolder: FolderPicker): Hono {
  const api = new Hono();
  // Retried commands aren't applied twice (client `commandId`, I-122).
  const once = commandIds(() => service.store);

  // This server as an environment (I-123) -------------------------------------------------------
  api.get("/environment", (c) => {
    const info = service.getEnvironment();
    const identity = c.get("identity");
    // Remote callers without a token (a client checking a pairing link, I-126): identity only.
    if (identity?.kind === "remote" && !identity.device) return c.json({ id: info.id, name: info.name, version: info.version, protocol: info.protocol });
    return c.json(info);
  });
  api.patch("/environment", async (c) => {
    const body = await readBody<UpdateEnvironmentRequest>(c);
    if (typeof body.name !== "string") throw new HttpError(400, "name must be a string");
    if (body.name.trim().length > MAX_ENVIRONMENT_NAME) throw new HttpError(400, `name can be at most ${MAX_ENVIRONMENT_NAME} characters`);
    return c.json(service.renameEnvironment(body.name));
  });

  // Projects ----------------------------------------------------------------------------------
  api.get("/projects", (c) => c.json(service.listProjects()));
  api.post("/projects", once, async (c) => {
    const body = await readBody<CreateProjectRequest>(c);
    requireString(body.path, "path");
    optional(body.name, "string", "name");
    return c.json(service.createProject(body));
  });
  api.patch("/projects/:id", async (c) => {
    const body = await readBody<UpdateProjectRequest>(c);
    optional(body.name, "string", "name");
    optionalFolderId(body.folderId);
    // A project's environment is set at creation and never changes (I-123).
    if ("environmentId" in body) throw new HttpError(400, "environmentId can't be changed");
    return c.json(service.updateProject(c.req.param("id"), body));
  });
  api.put("/projects/order", async (c) => {
    const body = await readBody<ReorderProjectsRequest>(c);
    requireIds(body.ids);
    return c.json(service.reorderProjects(body.ids));
  });
  // Host-only actions (I-125): opening apps, Finder and the native folder picker act on the host's
  // screen, meaningless (and unwanted) for remote devices.
  api.post("/projects/:id/open", localOnly);
  api.post("/workspaces/:id/open", localOnly);
  api.post("/fs/pick-folder", localOnly);
  api.post("/fs/reveal", localOnly);
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

  // Folders in the chat list (I-165) ---------------------------------------------------------
  api.get("/folders", (c) => c.json(service.listFolders()));
  api.post("/folders", once, async (c) => {
    const body = await readBody<CreateFolderRequest>(c);
    requireString(body.name, "name");
    if (body.projectId !== undefined && body.projectId !== null && typeof body.projectId !== "string") {
      throw new HttpError(400, "projectId must be a string or null");
    }
    return c.json(service.createFolder(body));
  });
  api.put("/folders/order", async (c) => {
    const body = await readBody<ReorderFoldersRequest>(c);
    requireString(body.projectId, "projectId");
    requireIds(body.ids);
    return c.json(service.reorderFolders(body.projectId, body.ids));
  });
  api.patch("/folders/:id", async (c) => {
    const body = await readBody<UpdateFolderRequest>(c);
    optional(body.name, "string", "name");
    return c.json(service.updateFolder(c.req.param("id"), body));
  });
  api.delete("/folders/:id", (c) => {
    service.deleteFolder(c.req.param("id"));
    return c.body(null, 204);
  });

  // Workspaces (sidebar rows) ----------------------------------------------------------------
  api.get("/workspaces", (c) => c.json(service.listWorkspaces()));
  api.post("/workspaces", once, async (c) => {
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
    optionalFolderId(body.folderId);
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
  api.post("/workspaces/:id/sessions", once, async (c) => {
    const body = await readOptionalBody<CreateSessionRequest>(c);
    requireNewSession(body);
    return c.json(await service.createSession(c.req.param("id"), body));
  });
  /** Legacy alias of `GET /workspaces` (the desktop app's quit check counts busy rows). */
  api.get("/chats", (c) => c.json(service.listWorkspaces()));

  // Sessions (one agent conversation each) ---------------------------------------------------
  api.get("/sessions", (c) => c.json(service.listSessions()));
  api.get("/sessions/:id", async (c) => c.json(await service.getSessionDetail(c.req.param("id"))));
  // Earlier turns of a transcript (I-122): `before` = index of the first message the client has.
  api.get("/sessions/:id/transcript", async (c) => {
    const before = c.req.query("before");
    const turns = c.req.query("turns");
    const parse = (value: string | undefined, name: string, min: number) => {
      if (value === undefined) return undefined;
      const n = Number(value);
      if (!Number.isInteger(n) || n < min) throw new HttpError(400, `${name} must be an integer ≥ ${min}`);
      return n;
    };
    return c.json(await service.getTranscriptPage(c.req.param("id"), parse(before, "before", 0), parse(turns, "turns", 1) ?? 50));
  });
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
  api.post("/sessions/:id/prompt", once, async (c) => {
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
  api.post("/sessions/:id/shell", once, async (c) => {
    const body = await readBody<ShellRequest>(c);
    requireString(body.command, "command");
    if (typeof body.shareWithAgent !== "boolean") throw new HttpError(400, "shareWithAgent must be a boolean");
    return c.json(await service.runShell(c.req.param("id"), { command: body.command, shareWithAgent: body.shareWithAgent }));
  });
  api.post("/sessions/:id/shell/abort", async (c) => {
    await service.abortShell(c.req.param("id"));
    return c.body(null, 204);
  });
  // Side questions (`/btw`, I-140).
  api.post("/sessions/:id/side-questions", once, async (c) => {
    const body = await readBody<SideQuestionRequest>(c);
    requireString(body.question, "question");
    const parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : undefined;
    return c.json(await service.askSideQuestion(c.req.param("id"), { question: body.question, ...(parentId ? { parentId } : {}) }));
  });
  api.post("/sessions/:id/side-questions/:qid/stop", (c) => {
    service.stopSideQuestion(c.req.param("id"), c.req.param("qid"));
    return c.body(null, 204);
  });
  api.post("/sessions/:id/side-questions/:qid/dismiss", (c) => {
    service.dismissSideQuestion(c.req.param("id"), c.req.param("qid"));
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
  api.put("/sessions/:id/permission-mode", async (c) => {
    const body = await readBody<{ mode: string }>(c);
    if (typeof body.mode !== "string" || !body.mode) throw new HttpError(400, "mode must be a non-empty string");
    await service.setPermissionMode(c.req.param("id"), body.mode);
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
    if (body.reveal && !isLocal(c)) return c.json({ code: "local_only", error: "Only the host itself can reveal files." }, 403);
    return withReveal(c, () => service.exportSession(c.req.param("id"), { reveal: body.reveal }));
  });
  // The export as a download (I-123): for clients not on the host (no Finder to reveal it in).
  api.get("/sessions/:id/export/download", async (c) => {
    const { path } = await service.exportSession(c.req.param("id"));
    const html = await readFile(path);
    const name = basename(path);
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    c.header("content-type", "text/html; charset=utf-8");
    c.header("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    return c.body(new Uint8Array(html));
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
  // Settings → Agents (I-155): every agent this device knows about, installed or not.
  api.get("/agent-catalog", (c) => c.json(service.agentCatalog()));
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
    // I-155: a device's settings (agents, models, commands, prompts, …) are changed on that device
    // only; other devices see them read-only. Only the look (appearance) may come from a client.
    if (!isLocal(c) && Object.keys(body).some((key) => key !== "appearance")) {
      return c.json({ code: "local_only", error: `Change this on ${service.getEnvironment().name}.` }, 403);
    }
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

/** `folderId` in a PATCH body: absent, a string, or null (I-165). */
function optionalFolderId(value: unknown): void {
  if (value !== undefined && value !== null && typeof value !== "string") throw new HttpError(400, "folderId must be a string or null");
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
  if (body.permissionMode != null) optional(body.permissionMode, "string", "permissionMode");
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
        typeof (i as Record<string, unknown>).data === "string" &&
        ((i as Record<string, unknown>).blob === undefined || typeof (i as Record<string, unknown>).blob === "string"),
    );
  if (!ok) throw new HttpError(400, "images must be [{ mimeType, data, blob? }]");
}
