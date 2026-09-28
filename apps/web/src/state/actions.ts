/**
 * User actions on projects, workspaces (sidebar rows), sessions (tabs) and settings. They call the API, apply the result to the
 * signals right away (the server also pushes upserts, which are idempotent), and report
 * failures as toasts. Settings updates are optimistic.
 *
 * I-123: every request goes to the environment the item belongs to (`state/env-api.ts`); new
 * items are tagged with it. Orders across environments are kept on this device (`env-order.ts`).
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
  WorktreeRemoval,
} from "@glade/protocol";
import { activeMainSessionId } from "@glade/protocol";
import { applySessionDetail } from "./chat-session";
import { apiFor, apiForProject, apiForSession, apiForWorkspace } from "./env-api";
import { connectionFor } from "./env-registry";
import { setClientOrder } from "./env-order";
import {
  PROJECT_ORDER,
  envIdOf,
  envIdOfProject,
  itemOrderKey,
  pinOrderList,
  projects,
  sessions,
  shellOf,
  sortedProjects,
  upsert,
  workspaces,
  workspacesForProject,
} from "./store";
import { notify } from "./toasts";
import { resetNewChatWorktree, worktreeRequestFor } from "./worktrees";

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

/** Tag a new item with its environment (only when that environment is connected; else untagged = local). */
function tagged<T extends { environmentId?: string }>(item: T, envId: string | undefined): T {
  return envId && connectionFor(envId) && item.environmentId !== envId ? { ...item, environmentId: envId } : item;
}

/** Keep the environment tag of the item a server answer replaces. */
function retag<T extends { id: string; environmentId?: string }>(list: T[], item: T): T {
  const env = list.find((x) => x.id === item.id)?.environmentId;
  return env && !item.environmentId ? { ...item, environmentId: env } : item;
}

/** Ids of one environment, in the given order. */
function idsOfEnv<T extends { id: string; environmentId?: string }>(ordered: string[], all: T[], envId: string): string[] {
  const byId = new Map(all.map((x) => [x.id, x]));
  return ordered.filter((id) => envIdOf(byId.get(id)) === envId);
}

// Workspaces -----------------------------------------------------------------------------------

/**
 * Create a workspace with its first session (and first prompt) and seed the stores, so the caller
 * can navigate to it right away. Throws; the caller reports errors.
 */
export async function createWorkspace(req: CreateWorkspaceRequest, envId?: string): Promise<CreateWorkspaceResponse> {
  // A project chat runs on the project's environment; a standalone one on the chosen one (I-123).
  const env = req.projectId ? envIdOfProject(req.projectId) : envId;
  // The new-chat context bar's "Work in: New worktree" (I-096, I-105) is on for this project.
  const fromBar = req.worktree === undefined ? worktreeRequestFor(req.projectId) : {};
  const created = await apiFor(env).createWorkspace({ ...req, ...fromBar });
  if (fromBar.worktree) resetNewChatWorktree();
  const workspace = tagged(created.workspace, env);
  const newSessions = created.sessions.map((x) => tagged(x, env));
  workspaces.value = upsert(workspaces.value, workspace);
  sessions.value = newSessions.reduce(upsert, sessions.value);
  if (workspace !== created.workspace) {
    applySessionDetail({ ...created.session, session: tagged(created.session.session, env) });
    return { ...created, workspace, sessions: newSessions };
  }
  applySessionDetail(created.session);
  return created;
}

export async function updateWorkspace(id: string, patch: UpdateWorkspaceRequest): Promise<boolean> {
  try {
    const workspace = await apiForWorkspace(id).updateWorkspace(id, patch);
    workspaces.value = upsert(workspaces.value, retag(workspaces.value, workspace));
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
 * optimistically (`pinOrder` = index); restored and reported if the server rejects it. A list
 * mixing environments (standalone chats, I-123) keeps the interleaving on this device and sends
 * each environment its own part.
 */
export async function reorderPinnedWorkspaces(projectId: string | null, ids: string[]): Promise<boolean> {
  const all = workspaces.value;
  const before = new Map(all.filter((w) => ids.includes(w.id)).map((w) => [w.id, w.pinOrder]));
  const envs = [...new Set(ids.map((id) => envIdOf(all.find((w) => w.id === id))))];
  if (envs.length > 1) {
    const byId = new Map(all.map((w) => [w.id, w]));
    setClientOrder(pinOrderList(projectId), ids.flatMap((id) => (byId.has(id) ? [itemOrderKey(byId.get(id)!)] : [])));
  }
  const parts = envs.map((env) => idsOfEnv(ids, all, env));
  const order = new Map(parts.flatMap((part) => part.map((id, i) => [id, i] as const)));
  workspaces.value = all.map((w) => (order.has(w.id) ? { ...w, pinOrder: order.get(w.id) } : w));
  try {
    for (const [i, env] of envs.entries()) {
      const updated = await apiFor(env).reorderPinnedWorkspaces(projectId, parts[i]!);
      workspaces.value = updated.map((w) => tagged(retag(workspaces.value, w), env)).reduce(upsert, workspaces.value);
    }
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

/**
 * Delete a workspace and all of its sessions (permanently). `worktree`: what happens to a
 * worktree workspace's branch (I-096; the server keeps it by default).
 */
export async function deleteWorkspace(id: string, worktree?: WorktreeRemoval): Promise<boolean> {
  try {
    const client = apiForWorkspace(id);
    await (worktree ? client.deleteWorkspace(id, worktree) : client.deleteWorkspace(id));
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
    const raw = await apiForWorkspace(workspaceId).createSession(workspaceId, req);
    const env = workspaces.value.find((w) => w.id === workspaceId)?.environmentId;
    const detail = { ...raw, session: tagged(raw.session, env) };
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
    const session = await apiForSession(id).updateSession(id, patch);
    sessions.value = upsert(sessions.value, retag(sessions.value, session));
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

/** "Mark as Unread" / "Mark as Read" on one tab (its session). */
export const markSessionUnread = (sessionId: string) => updateSession(sessionId, { unread: true });
export const markSessionRead = (sessionId: string) => updateSession(sessionId, { unread: false });

/**
 * "Mark as Unread" on a sidebar row (I-073): flags the workspace's focused main tab (the last tab
 * you had open), so opening the chat lands on it and clears it.
 */
export function markWorkspaceUnread(workspaceId: string): Promise<boolean> {
  const workspace = workspaces.value.find((w) => w.id === workspaceId);
  const id = workspace ? activeMainSessionId(workspace, sessions.value) : null;
  return id ? markSessionUnread(id) : Promise.resolve(false);
}
export const dismissInterrupted = (sessionId: string) => updateSession(sessionId, { interrupted: false });

/** Close a tab (deletes its conversation). The server refuses the workspace's last main session. */
export async function deleteSession(id: string): Promise<boolean> {
  try {
    await apiForSession(id).deleteSession(id);
    sessions.value = sessions.value.filter((s) => s.id !== id && s.parentSessionId !== id);
    return true;
  } catch (err) {
    fail("Could not close tab", err);
    return false;
  }
}

// Projects -------------------------------------------------------------------------------------

/**
 * Create a project on an environment (default: the local one; I-123 the project's environment
 * is fixed from then on). Throws so the dialog can show the error inline.
 */
export async function addProject(path: string, name?: string, envId?: string): Promise<Project> {
  const project = tagged(await apiFor(envId).createProject({ path, ...(name ? { name } : {}) }), envId);
  projects.value = upsert(projects.value, project);
  return project;
}

export async function updateProject(id: string, patch: UpdateProjectRequest): Promise<boolean> {
  try {
    const project = await apiForProject(id).updateProject(id, patch);
    projects.value = upsert(projects.value, retag(projects.value, project));
    return true;
  } catch (err) {
    fail("Could not update project", err);
    return false;
  }
}

export const renameProject = (id: string, name: string) => updateProject(id, { name });

/**
 * Set the manual project order (full list of ids, possibly of several environments). Applied
 * optimistically (`sortOrder` = index within its environment); this device keeps how the
 * environments are interleaved (I-123), each server gets its own projects' order. Restored and
 * reported if a server rejects it.
 */
export async function reorderProjects(ids: string[]): Promise<boolean> {
  const all = projects.value;
  const byId = new Map(all.map((p) => [p.id, p]));
  const before = new Map(all.map((p) => [p.id, p.sortOrder]));
  setClientOrder(PROJECT_ORDER, ids.flatMap((id) => (byId.has(id) ? [itemOrderKey(byId.get(id)!)] : [])));
  const envs = [...new Set(ids.map((id) => envIdOf(byId.get(id))))];
  const parts = envs.map((env) => idsOfEnv(ids, all, env));
  const order = new Map(parts.flatMap((part) => part.map((id, i) => [id, i] as const)));
  projects.value = all.map((p) => (order.has(p.id) ? { ...p, sortOrder: order.get(p.id) as number } : p));
  try {
    for (const [i, env] of envs.entries()) {
      // Only environments whose own order changed are asked.
      const mine = parts[i]!;
      const was = [...all].filter((p) => envIdOf(p) === env).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((p) => p.id);
      if (envs.length > 1 && was.length === mine.length && was.every((id, j) => id === mine[j])) continue;
      const updated = await apiFor(env).reorderProjects(mine);
      projects.value = updated.map((p) => tagged(retag(projects.value, p), env)).reduce(upsert, projects.value);
    }
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
    await apiForProject(id).deleteProject(id);
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

/**
 * Optimistically apply a settings patch to an environment's settings (default: the local one;
 * I-123 host settings are edited on the environment that runs the agents), then persist it.
 * Reverts on failure.
 */
export async function updateSettings(patch: DeepPartial<Settings>, envId?: string | null): Promise<boolean> {
  const settings = shellOf(envId).settings;
  const previous = settings.value;
  settings.value = mergeSettings(previous, patch);
  try {
    settings.value = await apiFor(envId).updateSettings(patch);
    return true;
  } catch (err) {
    settings.value = previous;
    fail("Could not save settings", err);
    return false;
  }
}
