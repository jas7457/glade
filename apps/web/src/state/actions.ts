/**
 * User actions on projects, chats and settings. They call the API, apply the result to the
 * signals right away (the server also pushes upserts, which are idempotent), and report
 * failures as toasts. Settings updates are optimistic.
 */
import type { ChatSummary, DeepPartial, Project, Settings, UpdateChatRequest, UpdateProjectRequest } from "@pi-ui/protocol";
import { api } from "@/lib/api";
import { chats, projects, settings } from "./store";
import { notify } from "./toasts";

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const copy = list.slice();
  copy[idx] = item;
  return copy;
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
export const setChatArchived = (id: string, archived: boolean) => updateChat(id, { archived });

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
export const setProjectPinned = (id: string, pinned: boolean) => updateProject(id, { pinned });

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
