/**
 * Typed REST client for a Glade server (an *environment*, I-123). All routes are documented in
 * docs/ARCHITECTURE.md. `createApi(baseUrl)` makes a client for one environment's absolute API
 * base URL (`http://host:port/api`); `api` / `request` / `command` are the client of the *local*
 * environment (the server that served this page), the only place the page origin is implied.
 * Code that works on something of another environment gets its client from `state/env-api.ts`.
 *
 * Portable client core (F-022): no DOM or layout assumptions beyond `fetch`.
 */
import type {
  CompactResult,
  CreateProjectRequest,
  CreateSessionRequest,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  DeepPartial,
  GenerateTitleResponse,
  ModelInfo,
  OpenTarget,
  ModelRef,
  PickFolderResponse,
  Project,
  ProjectGitInfo,
  PromptRequest,
  SessionDetail,
  SessionSummary,
  Settings,
  TranscriptPageResponse,
  ShellRequest,
  ShellResponse,
  SlashCommand,
  ThinkingLevel,
  UiResponse,
  UpdateProjectRequest,
  UpdateSessionRequest,
  UpdateWorkspaceRequest,
  WorkspaceDetail,
  WorkspaceSummary,
  WorktreeRemoval,
  WorktreeStatus,
  EnvironmentInfo,
  UpdateEnvironmentRequest,
  AttachmentUploadResponse,
} from "@glade/protocol";
import { COMMAND_ID_HEADER } from "@glade/protocol";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The server's error code, e.g. `unauthorized` / `remote_disabled` (I-125). */
    readonly code?: string,
  ) {
    super(message);
  }
}

/** 401: no, invalid or revoked device token (I-125) — the client must pair again. */
export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 401;
}

/** 403 `remote_disabled`: the host has turned remote access off (I-125). */
export function isRemoteDisabled(err: unknown): boolean {
  return err instanceof ApiRequestError && err.status === 403 && err.code === "remote_disabled";
}

/** Per-request options of {@link requestAt}. */
export interface RequestOptions {
  /** Device token of a paired environment (I-125): sent as `Authorization: Bearer`. */
  token?: string | null;
  signal?: AbortSignal;
}

/** `Authorization` header for a device token (none without one). */
export function authHeaders(token: string | null | undefined): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** A JSON request against one environment (`path` is relative to its `/api` base). */
export type RequestFn = <T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>) => Promise<T>;

/** The local environment's API base: the page's own origin (`http://127.0.0.1:5317/api`). */
export function localBaseUrl(): string {
  const origin = typeof window !== "undefined" && window.location?.origin && window.location.origin !== "null" ? window.location.origin : "http://localhost";
  return `${origin}/api`;
}

/** Normalizes a server address to its API base: `http://h:1/` → `http://h:1/api`. */
export function apiBaseFromUrl(url: string): string {
  const u = new URL(url.trim());
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${path.endsWith("/api") ? path : `${path}/api`}`;
}

/** Shared JSON request helper against an absolute API base URL. */
export async function requestAt<T>(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
  options: RequestOptions = {},
): Promise<T> {
  const headers = { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...authHeaders(options.token), ...extraHeaders };
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) throw await errorFromResponse(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** The {@link ApiRequestError} for a failed response (`{error, code}` JSON bodies). */
export async function errorFromResponse(res: Response): Promise<ApiRequestError> {
  let message = res.statusText;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    message = body.error ?? message;
    code = body.code;
  } catch {
    /* not json */
  }
  return new ApiRequestError(res.status, message, code);
}

/**
 * A command that must not run twice (I-122): sent with a client `commandId`, and retried once
 * with the same id when the connection failed before an answer came (the server replays the
 * first answer instead of running it again).
 */
export async function commandVia<T>(send: RequestFn, method: string, path: string, body?: unknown): Promise<T> {
  const headers = { [COMMAND_ID_HEADER]: newCommandId() };
  try {
    return await send<T>(method, path, body, headers);
  } catch (err) {
    if (err instanceof ApiRequestError) throw err;
    await new Promise((r) => setTimeout(r, 500));
    return send<T>(method, path, body, headers);
  }
}

function newCommandId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The local environment's request helper (feature clients like `lib/api-search.ts` build on it). */
export function request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  return requestAt<T>(localBaseUrl(), method, path, body, extraHeaders);
}

/** A command against the local environment (see {@link commandVia}). */
export function command<T>(method: string, path: string, body?: unknown): Promise<T> {
  return commandVia<T>(request, method, path, body);
}

/** Fetch an environment's info from an address (`GET /api/environment`), e.g. to connect to it. */
export function fetchEnvironmentInfo(baseUrl: string): Promise<EnvironmentInfo> {
  return requestAt<EnvironmentInfo>(baseUrl, "GET", "/environment");
}

/** How {@link createApi} authenticates (I-125). */
export interface ApiAuth {
  /** The device token, read on every request (it can change after pairing again). */
  token: () => string | null | undefined;
  /** Called with every 401 / 403 `remote_disabled` answer (the environment's status follows). */
  onAuthError?: (err: ApiRequestError) => void;
}

/** A request function against `baseUrl` that sends the device token and reports auth errors. */
export function authedRequest(baseUrl: string, auth?: ApiAuth): RequestFn {
  return async <T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => {
    try {
      return await requestAt<T>(baseUrl, method, path, body, headers, { token: auth?.token() });
    } catch (err) {
      if (auth?.onAuthError && (isUnauthorized(err) || isRemoteDisabled(err))) auth.onAuthError(err as ApiRequestError);
      throw err;
    }
  };
}

/**
 * A typed client for one environment. `baseUrl` is absolute and ends in `/api`. Pass a
 * {@link RequestFn} (the local client) or {@link ApiAuth} (a paired environment's token).
 */
export function createApi(baseUrl: string, sendOrAuth?: RequestFn | ApiAuth) {
  const send: RequestFn = typeof sendOrAuth === "function" ? sendOrAuth : authedRequest(baseUrl, sendOrAuth);
  const auth = typeof sendOrAuth === "object" ? sendOrAuth : undefined;
  const token = () => auth?.token() ?? null;
  /** Raw bytes to this environment (attachments), with its token; JSON answer. */
  const upload = async <T>(path: string, body: Blob): Promise<T> => {
    const res = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/octet-stream", ...authHeaders(token()) }, body });
    if (!res.ok) {
      const err = await errorFromResponse(res);
      if (auth?.onAuthError && (isUnauthorized(err) || isRemoteDisabled(err))) auth.onAuthError(err);
      throw err;
    }
    return (await res.json()) as T;
  };
  const request = send;
  const command = <T>(method: string, path: string, body?: unknown) => commandVia<T>(send, method, path, body);
  return {
    baseUrl,
    request,
    command,
    /**
     * Upload a file referenced by a prompt (I-090) to the session's attachments folder on this
     * environment's host; the answer's `path` is a path on that host.
     */
    uploadAttachment: (sessionId: string, file: Blob, name: string) =>
      upload<AttachmentUploadResponse>(`/sessions/${sessionId}/attachments?name=${encodeURIComponent(name)}`, file),
    /** Headers a raw `fetch` against this environment needs (downloads). */
    authHeaders: () => authHeaders(token()),
    // Environment (I-123)
    getEnvironment: () => request<EnvironmentInfo>("GET", "/environment"),
    updateEnvironment: (body: UpdateEnvironmentRequest) => request<EnvironmentInfo>("PATCH", "/environment", body),
    /** The exported HTML of a chat as a file download (remote environments, I-123). */
    exportSessionDownloadUrl: (id: string) => `${baseUrl}/sessions/${id}/export/download`,

    // Projects
    listProjects: () => request<Project[]>("GET", "/projects"),
    createProject: (body: CreateProjectRequest) => command<Project>("POST", "/projects", body),
    updateProject: (id: string, body: UpdateProjectRequest) => request<Project>("PATCH", `/projects/${id}`, body),
    deleteProject: (id: string) => request<void>("DELETE", `/projects/${id}`),
    /** Full list of project ids in the new order. */
    reorderProjects: (ids: string[]) => request<Project[]>("PUT", "/projects/order", { ids }),
    openProject: (id: string, app: OpenTarget = "vscode") => request<void>("POST", `/projects/${id}/open`, { app }),
    /** Whether the project's folder is a git repository (worktree chats, I-096). */
    getProjectGit: (id: string) => request<ProjectGitInfo>("GET", `/projects/${id}/git`),
    /** Check out a branch in the project folder (I-105; 409 while dirty or a local chat is working). */
    checkoutProjectBranch: (id: string, branch: string) => request<ProjectGitInfo>("POST", `/projects/${id}/git/checkout`, { branch }),
    /** Create a branch from the project folder's HEAD, optionally checking it out (I-105). */
    createProjectBranch: (id: string, name: string, checkout: boolean) =>
      request<ProjectGitInfo>("POST", `/projects/${id}/git/branch`, { name, checkout }),

    // Workspaces (sidebar rows)
    listWorkspaces: () => request<WorkspaceSummary[]>("GET", "/workspaces"),
    createWorkspace: (body: CreateWorkspaceRequest) => command<CreateWorkspaceResponse>("POST", "/workspaces", body),
    getWorkspace: (id: string) => request<WorkspaceDetail>("GET", `/workspaces/${id}`),
    /** Open the chat's own folder (its worktree, or the project folder) in another app (I-106). */
    openWorkspace: (id: string, app: OpenTarget = "vscode") => request<void>("POST", `/workspaces/${id}/open`, { app }),
    updateWorkspace: (id: string, body: UpdateWorkspaceRequest) => request<WorkspaceSummary>("PATCH", `/workspaces/${id}`, body),
    /** `worktree`: what happens to a worktree workspace's branch (I-096; server default keep). */
    deleteWorkspace: (id: string, worktree?: WorktreeRemoval) =>
      request<void>("DELETE", `/workspaces/${id}${worktree ? `?worktree=${worktree}` : ""}`),
    getWorktreeStatus: (id: string) => request<WorktreeStatus>("GET", `/workspaces/${id}/worktree`),
    /** Pinned workspaces of one list (project id, or null for standalone ones) in the new order. */
    reorderPinnedWorkspaces: (projectId: string | null, ids: string[]) =>
      request<WorkspaceSummary[]>("PUT", "/workspaces/pin-order", { projectId, ids }),
    /** A new main session (tab) in a workspace. */
    createSession: (workspaceId: string, body: CreateSessionRequest = {}) =>
      command<SessionDetail>("POST", `/workspaces/${workspaceId}/sessions`, body),

    // Sessions (one agent conversation each; everything below takes a session id)
    listSessions: () => request<SessionSummary[]>("GET", "/sessions"),
    getSession: (id: string) => request<SessionDetail>("GET", `/sessions/${id}`),
    /** Earlier turns of a transcript, before message index `before` (I-122 "load earlier"). */
    getTranscriptPage: (id: string, before: number, turns = 50) =>
      request<TranscriptPageResponse>("GET", `/sessions/${id}/transcript?before=${before}&turns=${turns}`),
    updateSession: (id: string, body: UpdateSessionRequest) => request<SessionSummary>("PATCH", `/sessions/${id}`, body),
    /** Name the session from its conversation with the small model, applied like a rename (`/name`, I-074). */
    generateSessionTitle: (id: string) => request<GenerateTitleResponse>("POST", `/sessions/${id}/title/generate`),
    /** Close a tab (deletes its session file). Refused (409) for a workspace's last main session. */
    deleteSession: (id: string) => request<void>("DELETE", `/sessions/${id}`),
    prompt: (id: string, body: PromptRequest) => command<void>("POST", `/sessions/${id}/prompt`, body),
    abort: (id: string) => request<void>("POST", `/sessions/${id}/abort`),
    /** `!cmd` / `!!cmd` (I-076): run a shell command in the chat's folder; output arrives as `shell_*` events. */
    runShell: (id: string, body: ShellRequest) => command<ShellResponse>("POST", `/sessions/${id}/shell`, body),
    abortShell: (id: string) => request<void>("POST", `/sessions/${id}/shell/abort`),
    setModel: (id: string, model: ModelRef) => request<void>("PUT", `/sessions/${id}/model`, model),
    setThinkingLevel: (id: string, level: ThinkingLevel) => request<void>("PUT", `/sessions/${id}/thinking`, { level }),
    respondToUi: (id: string, body: UiResponse) => request<void>("POST", `/sessions/${id}/ui-response`, body),
    /** The harness's slash commands (Glade's built-ins are defined in features/chat/slash). */
    listCommands: (id: string) => request<SlashCommand[]>("GET", `/sessions/${id}/commands`),
    compact: (id: string, instructions?: string) =>
      request<CompactResult>("POST", `/sessions/${id}/compact`, instructions ? { instructions } : {}),
    exportSession: (id: string, options: { reveal?: boolean } = {}) =>
      request<{ path: string }>("POST", `/sessions/${id}/export`, options),
    /** Reveal a file the server exported in Finder (macOS). */
    revealFile: (path: string) => request<void>("POST", "/fs/reveal", { path }),

    // Models + settings
    listModels: (refresh = false) => request<ModelInfo[]>("GET", `/models${refresh ? "?refresh=1" : ""}`),
    getSettings: () => request<Settings>("GET", "/settings"),
    updateSettings: (patch: DeepPartial<Settings>) => request<Settings>("PATCH", "/settings", patch),

    // Native folder dialog on the server's machine (use `pickFolder()` from lib/native instead).
    pickFolder: (body: { prompt?: string; defaultPath?: string } = {}) =>
      request<PickFolderResponse>("POST", "/fs/pick-folder", body),
  };
}

export type ApiClient = ReturnType<typeof createApi>;

/** The local environment's client (the page-origin server; see the header). */
export const api: ApiClient = createApi(localBaseUrl(), request);
