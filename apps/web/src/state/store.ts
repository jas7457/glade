/**
 * Global app state (Preact signals). Server pushes keep these in sync; components read the
 * signals directly and call the actions below.
 */
import { computed, signal } from "@preact/signals";
import {
  activeMainSessionId,
  defaultSettings,
  mainSessionsOf,
  type HarnessDefaults,
  type ModelInfo,
  type Project,
  type ServerMessage,
  type SessionSummary,
  type Settings,
  type ShellSnapshot,
  type WorkspaceSummary,
} from "@glade/protocol";
import { api } from "@/lib/api";
import { getHarnessDefaults } from "@/lib/api-folder";
import { handleSessionEvent, reloadIfChangedElsewhere } from "./chat-session";
import { notify } from "./toasts";
import { handleUsageMessage } from "./usage";
import { loadHarnesses } from "./harnesses";
import { requestOpenChat } from "./open-chat";

export const projects = signal<Project[]>([]);
/** Sidebar rows (I-035). Each holds one or more sessions. */
export const workspaces = signal<WorkspaceSummary[]>([]);
/** Every session of every workspace (main tabs and sub-agents). */
export const sessions = signal<SessionSummary[]>([]);
export const models = signal<ModelInfo[]>([]);
/** What the harness itself uses when no model is given (pi's settings); "Default" means this (I-050). */
export const harnessDefaults = signal<HarnessDefaults | null>(null);
export const settings = signal<Settings>(defaultSettings());
export const initialized = signal(false);
export const initError = signal<string | null>(null);

/** Models shown in pickers (hidden ones filtered out). */
export const visibleModels = computed(() => {
  const hidden = new Set(settings.value.models.hiddenModels);
  return models.value.filter((m) => !hidden.has(`${m.provider}/${m.id}`));
});

export const projectsById = computed(() => new Map(projects.value.map((p) => [p.id, p])));
export const workspacesById = computed(() => new Map(workspaces.value.map((w) => [w.id, w])));
export const sessionsById = computed(() => new Map(sessions.value.map((s) => [s.id, s])));

/** Projects in their manual order (`sortOrder` ascending); never re-sorted by activity. */
export function compareProjects(a: Project, b: Project): number {
  // `?? 0` guards data from a server that predates `sortOrder`.
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

/**
 * Workspaces within one list: pinned first in their manual `pinOrder`, then the rest
 * newest-created first. Activity never moves a row.
 */
export function compareWorkspaces(a: WorkspaceSummary, b: WorkspaceSummary): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned) {
    const order = (a.pinOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinOrder ?? Number.MAX_SAFE_INTEGER);
    if (order !== 0) return order;
  }
  return b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

export const sortedProjects = computed(() => [...projects.value].sort(compareProjects));

export function workspacesForProject(projectId: string | null): WorkspaceSummary[] {
  return workspaces.value.filter((w) => w.projectId === projectId).sort(compareWorkspaces);
}

/** A workspace's main sessions in tab order. */
export function mainSessionsFor(workspaceId: string): SessionSummary[] {
  return mainSessionsOf(sessions.value, workspaceId, workspacesById.value.get(workspaceId)?.layout);
}

/**
 * The session to show for a workspace: `tab` when it's one of its main sessions, else the saved
 * active tab, else the first. `null` while the workspace's sessions aren't known.
 */
export function resolveSessionId(workspaceId: string, tab?: string | null): string | null {
  const workspace = workspacesById.value.get(workspaceId);
  if (!workspace) return null;
  const wanted = tab ? sessionsById.value.get(tab) : undefined;
  if (wanted && wanted.workspaceId === workspaceId && wanted.kind === "main") return wanted.id;
  return activeMainSessionId(workspace, sessions.value);
}

// ---------------------------------------------------------------------------------------------
// Loading + server push
// ---------------------------------------------------------------------------------------------

/** A sync snapshot of the shell was applied (I-122): it's newer than any list fetched over HTTP. */
let shellSynced = false;

export async function loadAll(): Promise<void> {
  try {
    const [p, w, ss, s] = await Promise.all([api.listProjects(), api.listWorkspaces(), api.listSessions(), api.getSettings()]);
    if (!shellSynced) {
      projects.value = p;
      workspaces.value = w;
      sessions.value = ss;
      settings.value = s;
    }
    initError.value = null;
  } catch (err) {
    initError.value = (err as Error).message;
  } finally {
    initialized.value = true;
  }
  // Models can be slow (spawns the agent); don't block the UI on them.
  void loadModels();
  void loadHarnesses();
}

export async function loadModels(refresh = false): Promise<void> {
  // Same utility process on the server (shared in-flight request), so a refresh updates both.
  const defaults = Promise.resolve()
    .then(() => getHarnessDefaults(refresh))
    .then(
    (d) => {
      harnessDefaults.value = d;
    },
    () => {
      /* not fatal: "Default" then falls back to the first model */
    },
  );
  try {
    models.value = await api.listModels(refresh);
  } catch (err) {
    notify("error", `Could not load models: ${(err as Error).message}`);
  }
  await defaults;
}

export function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const copy = list.slice();
  copy[idx] = item;
  return copy;
}

/** The shell scope's snapshot (I-122): replaces the lists and settings. */
export function applyShellSnapshot(shell: ShellSnapshot): void {
  shellSynced = true;
  const before = new Map(sessions.value.map((s) => [s.id, s]));
  projects.value = shell.projects;
  workspaces.value = shell.workspaces;
  sessions.value = shell.sessions;
  const acpChanged = JSON.stringify(settings.value.harnesses.acp) !== JSON.stringify(shell.settings.harnesses.acp);
  settings.value = shell.settings;
  if (acpChanged) void loadHarnesses();
  initError.value = null;
  initialized.value = true;
  for (const session of shell.sessions) reloadIfChangedElsewhere(before.get(session.id), session);
}

/**
 * After catching up (I-122), the lists are checked against every id the server has: ours that it
 * doesn't have are dropped. Returns true when the server has some we don't (take a snapshot).
 */
export function applyShellCheck(check: { projects: string[]; workspaces: string[]; sessions: string[] }): boolean {
  const ids = { projects: new Set(check.projects), workspaces: new Set(check.workspaces), sessions: new Set(check.sessions) };
  const prune = <T extends { id: string }>(list: T[], keep: Set<string>) => (list.every((x) => keep.has(x.id)) ? list : list.filter((x) => keep.has(x.id)));
  projects.value = prune(projects.value, ids.projects);
  workspaces.value = prune(workspaces.value, ids.workspaces);
  sessions.value = prune(sessions.value, ids.sessions);
  const missing = (list: Array<{ id: string }>, all: Set<string>) => list.length < all.size;
  return missing(projects.value, ids.projects) || missing(workspaces.value, ids.workspaces) || missing(sessions.value, ids.sessions);
}

/** Tests: forget that a snapshot was applied. */
export function resetShellSync(): void {
  shellSynced = false;
}

export function handleServerMessage(message: ServerMessage): void {
  switch (message.type) {
    case "workspace_upsert":
      workspaces.value = upsert(workspaces.value, message.workspace);
      break;
    case "workspace_removed":
      workspaces.value = workspaces.value.filter((w) => w.id !== message.workspaceId);
      sessions.value = sessions.value.filter((s) => s.workspaceId !== message.workspaceId);
      break;
    case "session_upsert": {
      const previous = sessions.value.find((s) => s.id === message.session.id);
      sessions.value = upsert(sessions.value, message.session);
      reloadIfChangedElsewhere(previous, message.session);
      break;
    }
    case "session_removed":
      sessions.value = sessions.value.filter((s) => s.id !== message.sessionId);
      break;
    case "project_upsert":
      projects.value = upsert(projects.value, message.project);
      break;
    case "project_removed":
      projects.value = projects.value.filter((p) => p.id !== message.projectId);
      break;
    case "settings": {
      // ACP agents added/removed (I-119), maybe in another window: they're harnesses too.
      const acpChanged = JSON.stringify(settings.value.harnesses.acp) !== JSON.stringify(message.settings.harnesses.acp);
      settings.value = message.settings;
      if (acpChanged) void loadHarnesses();
      break;
    }
    case "models":
      models.value = message.models;
      break;
    case "session_event":
      handleSessionEvent(message.sessionId, message.event);
      break;
    case "usage_limits":
      handleUsageMessage(message.usage);
      break;
    case "open_chat":
      requestOpenChat(message);
      break;
    case "hello":
      break;
  }
}
