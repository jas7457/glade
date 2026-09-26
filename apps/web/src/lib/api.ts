/**
 * Typed REST client for the pi-ui server. All routes are documented in docs/ARCHITECTURE.md.
 */
import type {
  ChatDetail,
  ChatSummary,
  CreateChatRequest,
  CreateProjectRequest,
  DeepPartial,
  ModelInfo,
  ModelRef,
  PickFolderResponse,
  Project,
  PromptRequest,
  Settings,
  ThinkingLevel,
  UiResponse,
  UpdateChatRequest,
  UpdateProjectRequest,
} from "@pi-ui/protocol";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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

  // Chats
  listChats: () => request<ChatSummary[]>("GET", "/chats"),
  createChat: (body: CreateChatRequest) => request<ChatDetail>("POST", "/chats", body),
  getChat: (id: string) => request<ChatDetail>("GET", `/chats/${id}`),
  updateChat: (id: string, body: UpdateChatRequest) => request<ChatSummary>("PATCH", `/chats/${id}`, body),
  deleteChat: (id: string) => request<void>("DELETE", `/chats/${id}`),
  prompt: (id: string, body: PromptRequest) => request<void>("POST", `/chats/${id}/prompt`, body),
  abort: (id: string) => request<void>("POST", `/chats/${id}/abort`),
  setModel: (id: string, model: ModelRef) => request<void>("PUT", `/chats/${id}/model`, model),
  setThinkingLevel: (id: string, level: ThinkingLevel) => request<void>("PUT", `/chats/${id}/thinking`, { level }),
  respondToUi: (id: string, body: UiResponse) => request<void>("POST", `/chats/${id}/ui-response`, body),

  // Models + settings
  listModels: (refresh = false) => request<ModelInfo[]>("GET", `/models${refresh ? "?refresh=1" : ""}`),
  getSettings: () => request<Settings>("GET", "/settings"),
  updateSettings: (patch: DeepPartial<Settings>) => request<Settings>("PATCH", "/settings", patch),

  // Native folder dialog on the server's machine (use `pickFolder()` from lib/native instead).
  pickFolder: (body: { prompt?: string; defaultPath?: string } = {}) =>
    request<PickFolderResponse>("POST", "/fs/pick-folder", body),
};
