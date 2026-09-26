/**
 * User actions on projects, workspaces (sidebar rows), sessions (tabs) and settings. They call the API, apply the result to the
 * signals right away (the server also pushes upserts, which are idempotent), and report
 * failures as toasts. Settings updates are optimistic.
 */
import type {
  CreateSessionRequest,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  DeepPartial,
  Project,
  SessionDetail,
  Settings,
  UpdateProjectRequest,
  UpdateSessionRequest,
  UpdateWorkspaceRequest,
} from "@pi-ui/protocol";
import { api } from "@/lib/api";
import { applySessionDetail } from "./chat-session";
import { projects, sessions, settings, sortedProjects, upsert, workspaces, workspacesForProject } from "./store";
import { notify } from "./toasts";

/** `ids` with `id` swapped one step up (-1) or down (+1); null at the edges or if missing. */
export function stepOrder(ids: readonly string[], id: string, delta: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= ids.length) return null;
  const next = ids.slice();
  next[from] = ids[to] as string;
  next[to] = id;
  return next;
}

function fail(prefix: string, err: unknown): void {
  notify("error", `${prefix}: ${(err as Error).message}`);
}

// Workspaces -----------------------------------------------------------------------------------

/**
 * Create a workspace with its first session (and first prompt) and seed the stores, so the caller
 * can navigate to it right away. Throws; the caller reports errors.
 */
export async function createWorkspace(req: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
  const created = await api.createWorkspace(req);
  workspaces.value = upsert(workspaces.value, created.workspace);
  sessions.value = created.sessions.reduce(upsert, sessions.value);
  applySessionDetail(created.session);
  return created;
}

export async function updateWorkspace(id: string, patch: UpdateWorkspaceRequest): Promise<boolean> {
  try {
    const workspace = await api.updateWorkspace(id, patch);
    workspaces.value = upsert(workspaces.value, workspace);
    return true;
  } catch (err) {
    fail("Could not update chat", err);
    return false;
  }
}

export const renameWorkspace = (id: string, title: string) => updateWorkspace(id, { title });
export const setWorkspacePinned = (id: string, pinned: boolean) => updateWorkspace(id, { pinned });

/**
 * Reorder the pinned workspaces of one list (a project, or standalone = null). Applied
 * optimistically (`pinOrder` = index); restored and reported if the server rejects it.
 */
export async function reorderPinnedWorkspaces(projectId: string | null, ids: string[]): Promise<boolean> {
  const before = new Map(workspaces.value.filter((w) => ids.includes(w.id)).map((w) => [w.id, w.pinOrder]));
  const order = new Map(ids.map((id, i) => [id, i]));
  workspaces.value = workspaces.value.map((w) => (order.has(w.id) ? { ...w, pinOrder: order.get(w.id) } : w));
  try {
    const updated = await api.reorderPinnedWorkspaces(projectId, ids);
    workspaces.value = updated.reduce(upsert, workspaces.value);
    return true;
  } catch (err) {
    workspaces.value = workspaces.value.map((w) => (before.has(w.id) ? { ...w, pinOrder: before.get(w.id) } : w));
    fail("Could not reorder chats", err);
    return false;
  }
}

/** Keyboard alternative to dragging: move a pinned workspace one step within its pinned group. */
export function movePinnedWorkspace(id: string, delta: -1 | 1): Promise<boolean> {
  const workspace = workspaces.value.find((w) => w.id === id);
  if (!workspace?.pinned) return Promise.resolve(false);
  const ids = workspacesForProject(workspace.projectId)
    .filter((w) => w.pinned)
    .map((w) => w.id);
  const next = stepOrder(ids, id, delta);
  return next ? reorderPinnedWorkspaces(workspace.projectId, next) : Promise.resolve(false);
}

/** Delete a workspace and all of its sessions (permanently). */
export async function deleteWorkspace(id: string): Promise<boolean> {
  try {
    await api.deleteWorkspace(id);
    workspaces.value = workspaces.value.filter((w) => w.id !== id);
    sessions.value = sessions.value.filter((s) => s.workspaceId !== id);
    return true;
  } catch (err) {
    fail("Could not delete chat", err);
    return false;
  }
}

// Sessions (tabs) ------------------------------------------------------------------------------

/** Open a new main session (tab) in a workspace; seeds the stores. Null (and a toast) on failure. */
export async function createSession(workspaceId: string, req: CreateSessionRequest = {}): Promise<SessionDetail | null> {
  try {
    const detail = await api.createSession(workspaceId, req);
    sessions.value = upsert(sessions.value, detail.session);
    applySessionDetail(detail);
    return detail;
  } catch (err) {
    fail("Could not open a new tab", err);
    return null;
  }
}

export async function updateSession(id: string, patch: UpdateSessionRequest): Promise<boolean> {
  try {
    const session = await api.updateSession(id, patch);
    sessions.value = upsert(sessions.value, session);
    return true;
  } catch (err) {
    fail("Could not update chat", err);
    return false;
  }
}

export const renameSession = (id: string, title: string) => updateSession(id, { title });

/**
 * Rename "this chat" from inside a session (`/name`): while it's the workspace's only main tab
 * the sidebar row is renamed (the server renames the tab with it), otherwise just the tab.
 */
export function renameFromSession(sessionId: string, title: string): Promise<boolean> {
  const session = sessions.value.find((s) => s.id === sessionId);
  if (!session) return Promise.resolve(false);
  const tabs = sessions.value.filter((s) => s.workspaceId === session.workspaceId && s.kind === "main");
  return session.kind === "main" && tabs.length <= 1 ? renameWorkspace(session.workspaceId, title) : renameSession(sessionId, title);
}

/** "Mark as Read" on a sidebar row: clears unread on each of the workspace's sessions. */
export async function markWorkspaceRead(workspaceId: string): Promise<boolean> {
  const unread = sessions.value.filter((s) => s.workspaceId === workspaceId && s.unread);
  const results = await Promise.all(unread.map((s) => updateSession(s.id, { unread: false })));
  return results.every(Boolean);
}
export const dismissInterrupted = (sessionId: string) => updateSession(sessionId, { interrupted: false });

/** Close a tab (deletes its conversation). The server refuses the workspace's last main session. */
export async function deleteSession(id: string): Promise<boolean> {
  try {
    await api.deleteSession(id);
    sessions.value = sessions.value.filter((s) => s.id !== id && s.parentSessionId !== id);
    return true;
  } catch (err) {
    fail("Could not close tab", err);
    return false;
  }
}

// Projects -------------------------------------------------------------------------------------

/** Create a project; throws so the dialog can show the error inline. */
export async function addProject(path: string, name?: string): Promise<Project> {
  const project = await api.createProject({ path, ...(name ? { name } : {}) });
  projects.value = upsert(projects.value, project);
  return project;
}

export async function updateProject(id: string, patch: UpdateProjectRequest): Promise<boolean> {
  try {
    const project = await api.updateProject(id, patch);
    projects.value = upsert(projects.value, project);
    return true;
  } catch (err) {
    fail("Could not update project", err);
    return false;
  }
}

export const renameProject = (id: string, name: string) => updateProject(id, { name });

/**
 * Set the manual project order (full list of ids). Applied optimistically (`sortOrder` =
 * index); restored and reported if the server rejects it.
 */
export async function reorderProjects(ids: string[]): Promise<boolean> {
  const before = new Map(projects.value.map((p) => [p.id, p.sortOrder]));
  const order = new Map(ids.map((id, i) => [id, i]));
  projects.value = projects.value.map((p) => (order.has(p.id) ? { ...p, sortOrder: order.get(p.id) as number } : p));
  try {
    const updated = await api.reorderProjects(ids);
    projects.value = updated.reduce(upsert, projects.value);
    return true;
  } catch (err) {
    projects.value = projects.value.map((p) => (before.has(p.id) ? { ...p, sortOrder: before.get(p.id) as number } : p));
    fail("Could not reorder projects", err);
    return false;
  }
}

/** Keyboard alternative to dragging: move a project one step up or down. */
export function moveProject(id: string, delta: -1 | 1): Promise<boolean> {
  const next = stepOrder(
    sortedProjects.value.map((p) => p.id),
    id,
    delta,
  );
  return next ? reorderProjects(next) : Promise.resolve(false);
}

export async function removeProject(id: string): Promise<boolean> {
  try {
    await api.deleteProject(id);
    projects.value = projects.value.filter((p) => p.id !== id);
    const gone = new Set(workspaces.value.filter((w) => w.projectId === id).map((w) => w.id));
    workspaces.value = workspaces.value.filter((w) => !gone.has(w.id));
    sessions.value = sessions.value.filter((s) => !gone.has(s.workspaceId));
    return true;
  } catch (err) {
    fail("Could not remove project", err);
    return false;
  }
}

// Settings -------------------------------------------------------------------------------------

type PlainObject = Record<string, unknown>;
const isPlainObject = (v: unknown): v is PlainObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-merge a settings patch (arrays and scalars replace, objects merge). */
export function mergeSettings(base: Settings, patch: DeepPartial<Settings>): Settings {
  const merge = (a: PlainObject, b: PlainObject): PlainObject => {
    const out: PlainObject = { ...a };
    for (const [key, value] of Object.entries(b)) {
      if (value === undefined) continue;
      out[key] = isPlainObject(value) && isPlainObject(a[key]) ? merge(a[key] as PlainObject, value) : value;
    }
    return out;
  };
  return merge(base as unknown as PlainObject, patch as PlainObject) as unknown as Settings;
}

/** Optimistically apply a settings patch, then persist it. Reverts on failure. */
export async function updateSettings(patch: DeepPartial<Settings>): Promise<boolean> {
  const previous = settings.value;
  settings.value = mergeSettings(previous, patch);
  try {
    settings.value = await api.updateSettings(patch);
    return true;
  } catch (err) {
    settings.value = previous;
    fail("Could not save settings", err);
    return false;
  }
}
