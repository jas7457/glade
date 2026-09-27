/**
 * Typed REST client for the Glade server. All routes are documented in docs/ARCHITECTURE.md.
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
  PromptRequest,
  SessionDetail,
  SessionSummary,
  Settings,
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
} from "@glade/protocol";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Shared JSON request helper; feature-specific clients (e.g. `lib/api-search.ts`) build on it. */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      /* not json */
    }
    throw new ApiRequestError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // Projects
  listProjects: () => request<Project[]>("GET", "/projects"),
  createProject: (body: CreateProjectRequest) => request<Project>("POST", "/projects", body),
  updateProject: (id: string, body: UpdateProjectRequest) => request<Project>("PATCH", `/projects/${id}`, body),
  deleteProject: (id: string) => request<void>("DELETE", `/projects/${id}`),
  /** Full list of project ids in the new order. */
  reorderProjects: (ids: string[]) => request<Project[]>("PUT", "/projects/order", { ids }),
  openProject: (id: string, app: OpenTarget = "vscode") => request<void>("POST", `/projects/${id}/open`, { app }),

  // Workspaces (sidebar rows)
  listWorkspaces: () => request<WorkspaceSummary[]>("GET", "/workspaces"),
  createWorkspace: (body: CreateWorkspaceRequest) => request<CreateWorkspaceResponse>("POST", "/workspaces", body),
  getWorkspace: (id: string) => request<WorkspaceDetail>("GET", `/workspaces/${id}`),
  updateWorkspace: (id: string, body: UpdateWorkspaceRequest) => request<WorkspaceSummary>("PATCH", `/workspaces/${id}`, body),
  deleteWorkspace: (id: string) => request<void>("DELETE", `/workspaces/${id}`),
  /** Pinned workspaces of one list (project id, or null for standalone ones) in the new order. */
  reorderPinnedWorkspaces: (projectId: string | null, ids: string[]) =>
    request<WorkspaceSummary[]>("PUT", "/workspaces/pin-order", { projectId, ids }),
  /** A new main session (tab) in a workspace. */
  createSession: (workspaceId: string, body: CreateSessionRequest = {}) =>
    request<SessionDetail>("POST", `/workspaces/${workspaceId}/sessions`, body),

  // Sessions (one agent conversation each; everything below takes a session id)
  listSessions: () => request<SessionSummary[]>("GET", "/sessions"),
  getSession: (id: string) => request<SessionDetail>("GET", `/sessions/${id}`),
  updateSession: (id: string, body: UpdateSessionRequest) => request<SessionSummary>("PATCH", `/sessions/${id}`, body),
  /** Name the session from its conversation with the small model, applied like a rename (`/name`, I-074). */
  generateSessionTitle: (id: string) => request<GenerateTitleResponse>("POST", `/sessions/${id}/title/generate`),
  /** Close a tab (deletes its session file). Refused (409) for a workspace's last main session. */
  deleteSession: (id: string) => request<void>("DELETE", `/sessions/${id}`),
  prompt: (id: string, body: PromptRequest) => request<void>("POST", `/sessions/${id}/prompt`, body),
  abort: (id: string) => request<void>("POST", `/sessions/${id}/abort`),
  /** `!cmd` / `!!cmd` (I-076): run a shell command in the chat's folder; output arrives as `shell_*` events. */
  runShell: (id: string, body: ShellRequest) => request<ShellResponse>("POST", `/sessions/${id}/shell`, body),
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
