/**
 * User actions on projects, chats and settings. They call the API, apply the result to the
 * signals right away (the server also pushes upserts, which are idempotent), and report
 * failures as toasts. Settings updates are optimistic.
 */
import type { ChatSummary, DeepPartial, Project, Settings, UpdateChatRequest, UpdateProjectRequest } from "@pi-ui/protocol";
import { api } from "@/lib/api";
import { chats, chatsForProject, projects, settings, sortedProjects } from "./store";
import { notify } from "./toasts";

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const copy = list.slice();
  copy[idx] = item;
  return copy;
}

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

// Chats ----------------------------------------------------------------------------------------

export async function updateChat(id: string, patch: UpdateChatRequest): Promise<boolean> {
  try {
    const chat = await api.updateChat(id, patch);
    chats.value = upsert(chats.value, chat);
    return true;
  } catch (err) {
    fail("Could not update chat", err);
    return false;
  }
}

export const renameChat = (id: string, title: string) => updateChat(id, { title });
export const setChatPinned = (id: string, pinned: boolean) => updateChat(id, { pinned });
export const dismissInterrupted = (id: string) => updateChat(id, { interrupted: false });

/**
 * Reorder the pinned chats of one list (a project, or standalone = null). Applied optimistically
 * (`pinOrder` = index); restored and reported if the server rejects it.
 */
export async function reorderPinnedChats(projectId: string | null, ids: string[]): Promise<boolean> {
  const before = new Map(chats.value.filter((c) => ids.includes(c.id)).map((c) => [c.id, c.pinOrder]));
  const order = new Map(ids.map((id, i) => [id, i]));
  chats.value = chats.value.map((c) => (order.has(c.id) ? { ...c, pinOrder: order.get(c.id) } : c));
  try {
    const updated = await api.reorderPinnedChats(projectId, ids);
    chats.value = updated.reduce(upsert, chats.value);
    return true;
  } catch (err) {
    chats.value = chats.value.map((c) => (before.has(c.id) ? { ...c, pinOrder: before.get(c.id) } : c));
    fail("Could not reorder chats", err);
    return false;
  }
}

/** Keyboard alternative to dragging: move a pinned chat one step within its pinned group. */
export function movePinnedChat(id: string, delta: -1 | 1): Promise<boolean> {
  const chat = chats.value.find((c) => c.id === id);
  if (!chat?.pinned) return Promise.resolve(false);
  const ids = chatsForProject(chat.projectId).filter((c) => c.pinned).map((c) => c.id);
  const next = stepOrder(ids, id, delta);
  return next ? reorderPinnedChats(chat.projectId, next) : Promise.resolve(false);
}

export async function deleteChat(id: string): Promise<boolean> {
  try {
    await api.deleteChat(id);
    chats.value = chats.value.filter((c) => c.id !== id);
    return true;
  } catch (err) {
    fail("Could not delete chat", err);
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
    chats.value = chats.value.filter((c: ChatSummary) => c.projectId !== id);
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
