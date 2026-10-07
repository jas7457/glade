/**
 * Global app state (Preact signals). Server pushes keep these in sync; components read the
 * signals directly and call the actions below.
 *
 * I-123: `projects`, `workspaces` and `sessions` are the *merged* lists of every connected
 * environment; each item is tagged with its `environmentId` when it arrives (untagged = the
 * primary, i.e. local, environment). Settings, models and harnesses are per environment
 * (`EnvShell`); the global `settings` / `models` / `harnessDefaults` signals are the local
 * environment's shell (`localShell`). Everything that applies server data takes the environment
 * it came from.
 */
import { computed, signal, type Signal } from "@preact/signals";
import {
  activeMainSessionId,
  defaultSettings,
  mainSessionsOf,
  type Folder,
  compareListOrder,
  agentModelSettings,
  quickTasksModel,
  type AgentModelSettings,
  type HarnessDefaults,
  type ModelInfo,
  type QuickTasksModel,
  type Project,
  type ServerMessage,
  type SessionSummary,
  type Settings,
  type ShellSnapshot,
  type WorkspaceSummary,
} from "@glade/protocol";
import { api, request } from "@glade/app-core/lib/api";
import { getHarnessDefaults } from "@glade/app-core/lib/api-folder";
import { connectionFor, connections, isLocalEnvironment, primaryEnvironmentId, type EnvShell } from "./env-registry";
import { clientOrders, interleave, orderKey } from "./env-order";
import { handleSessionEvent, reloadIfChangedElsewhere } from "./chat-session";
import { notify } from "./toasts";
import { handleUsageMessage } from "./usage";
import { handleLocalModelsMessage } from "./local-models";
import { harnesses, loadHarnesses } from "./harnesses";
import { requestOpenChat } from "./open-chat";
import { buildChatList, chatsOfView, foldersOfProject, workspaceFolderId, type ChatListView } from "./folders";

export const projects = signal<Project[]>([]);
/** Sidebar rows (I-035). Each holds one or more sessions. */
export const workspaces = signal<WorkspaceSummary[]>([]);
/** Every session of every workspace (main tabs and sub-agents). */
export const sessions = signal<SessionSummary[]>([]);
/** Folders in the chat list (I-165), every environment's. */
export const folders = signal<Folder[]>([]);
export const models = signal<ModelInfo[]>([]);
/** What the harness itself uses when no model is given (pi's settings); "Default" means this (I-050). */
export const harnessDefaults = signal<HarnessDefaults | null>(null);
export const settings = signal<Settings>(defaultSettings());
export const initialized = signal(false);
export const initError = signal<string | null>(null);

/** The local environment's shell (the global signals above). */
export const localShell: EnvShell = { settings, models, harnessDefaults, harnesses, initialized, initError };

/** The shell of an environment (the local one for untagged/unknown). */
export function shellOf(envId?: string | null): EnvShell {
  return connectionFor(envId)?.shell ?? localShell;
}

/**
 * The models of one harness (I-173: the list has every offered harness's, each tagged, the host's
 * default model-picker harness first). Without `harness`: the first listed harness's (what the
 * model settings offer). Untagged models (older hosts) belong to every harness.
 */
export function modelsForHarness(models: ModelInfo[], harness?: string | null): ModelInfo[] {
  const id = harness ?? models[0]?.harness;
  return id ? models.filter((m) => !m.harness || m.harness === id) : models;
}

/**
 * The id of a shell's default agent (I-198: the owner of an older server's global model settings,
 * see `agentModelSettings`): the harness list's default, else the `agent.defaultHarness` setting,
 * else the first listed model's agent. `null` before anything says.
 */
export function defaultHarnessIdOf(shell: EnvShell): string | null {
  const list = shell.harnesses?.value;
  return list?.find((h) => h.isDefault)?.id ?? list?.[0]?.id ?? shell.settings.value.agent?.defaultHarness ?? shell.models.value[0]?.harness ?? null;
}

/** Agent `harness`'s model settings on a shell (defaults filled in; I-198). */
export function agentModelsOf(shell: EnvShell, harness: string): AgentModelSettings {
  return agentModelSettings(shell.settings.value, harness, defaultHarnessIdOf(shell));
}

/** The Glade-wide quick-tasks model of a shell (`null` = automatic; I-198). */
export function quickTasksModelOf(shell: EnvShell): QuickTasksModel | null {
  return quickTasksModel(shell.settings.value, defaultHarnessIdOf(shell));
}

/**
 * Models of a shell shown in pickers for `harness` (see {@link modelsForHarness}), that agent's
 * hidden ones filtered out (I-198: hiding is per agent).
 */
export function visibleModelsOf(shell: EnvShell, harness?: string | null): ModelInfo[] {
  const list = modelsForHarness(shell.models.value, harness);
  const id = harness ?? shell.models.value[0]?.harness ?? defaultHarnessIdOf(shell);
  if (!id) return list;
  const hidden = new Set(agentModelsOf(shell, id).hiddenModels);
  return list.filter((m) => !hidden.has(`${m.provider}/${m.id}`));
}

/**
 * Each agent's own defaults (`GET /api/models/default?harness=`, I-198), per shell. The default
 * agent's are the shell's `harnessDefaults` (loaded with the models).
 */
let agentDefaults = new WeakMap<EnvShell, Map<string, Signal<HarnessDefaults | null>>>();
const agentDefaultsLoading = new Set<Signal<HarnessDefaults | null>>();

function agentDefaultsSignal(shell: EnvShell, harness: string): Signal<HarnessDefaults | null> {
  let map = agentDefaults.get(shell);
  if (!map) agentDefaults.set(shell, (map = new Map()));
  let s = map.get(harness);
  if (!s) map.set(harness, (s = signal<HarnessDefaults | null>(null)));
  return s;
}

/**
 * Agent `harness`'s own default model + thinking level on an environment (what its "Default"
 * means), `null` until known. Reading it starts loading it once (`loadAgentDefaults`).
 */
export function agentDefaultsOf(harness: string | null | undefined, envId?: string | null): HarnessDefaults | null {
  const shell = shellOf(envId);
  if (!harness || harness === defaultHarnessIdOf(shell)) return shell.harnessDefaults.value;
  const s = agentDefaultsSignal(shell, harness);
  if (s.peek() === null && !agentDefaultsLoading.has(s)) void loadAgentDefaults(harness, envId);
  return s.value;
}

/** Forget every agent's loaded defaults (tests). */
export function resetAgentDefaults(): void {
  agentDefaults = new WeakMap();
}

/** Load (or with `refresh`, re-read) agent `harness`'s own defaults on an environment. */
export async function loadAgentDefaults(harness: string, envId?: string | null, refresh = false): Promise<void> {
  const conn = clientOf(envId);
  const shell = conn?.shell ?? localShell;
  const s = agentDefaultsSignal(shell, harness);
  if (agentDefaultsLoading.has(s)) return;
  agentDefaultsLoading.add(s);
  try {
    s.value = await getHarnessDefaults(refresh, conn?.request, harness);
  } catch {
    // Not fatal: "Default" then names no model (and isn't asked again on every render).
    if (s.peek() === null) s.value = { model: null, thinkingLevel: null };
  } finally {
    agentDefaultsLoading.delete(s);
  }
}

/** Models shown in pickers (hidden ones filtered out), local environment. */
export const visibleModels = computed(() => visibleModelsOf(localShell));

/** The environment an item belongs to (`environmentId`, else the primary/local one). */
export function envIdOf(item: { environmentId?: string } | undefined | null): string {
  return item?.environmentId ?? primaryEnvironmentId();
}

export const projectsById = computed(() => new Map(projects.value.map((p) => [p.id, p])));
export const workspacesById = computed(() => new Map(workspaces.value.map((w) => [w.id, w])));
export const sessionsById = computed(() => new Map(sessions.value.map((s) => [s.id, s])));
export const foldersById = computed(() => new Map(folders.value.map((f) => [f.id, f])));

/** Projects in their manual order (`sortOrder` ascending); never re-sorted by activity. */
export function compareProjects(a: Project, b: Project): number {
  // `?? 0` guards data from a server that predates `sortOrder`.
  return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

/**
 * Workspaces within one list: pinned first in their manual `pinOrder`, then the rest in their
 * manual order (`sortOrder`, I-202; folders aside). Activity never moves a row.
 */
export function compareWorkspaces(a: WorkspaceSummary, b: WorkspaceSummary): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned) {
    const order = (a.pinOrder ?? Number.MAX_SAFE_INTEGER) - (b.pinOrder ?? Number.MAX_SAFE_INTEGER);
    if (order !== 0) return order;
  }
  return compareListOrder(a, b);
}

export const envIdOfProject = (id: string | null | undefined): string => envIdOf(id ? projectsById.value.get(id) : null);
export const envIdOfWorkspace = (id: string | null | undefined): string => envIdOf(id ? workspacesById.value.get(id) : null);
export const envIdOfSession = (id: string | null | undefined): string => envIdOf(id ? sessionsById.value.get(id) : null);

/** Environment ids in list order: local (primary) first, then the connections. */
function envOrder(): string[] {
  const primary = primaryEnvironmentId();
  return [primary, ...connections.value.map((c) => c.id).filter((id) => id !== primary)];
}

/** Split a sorted list by environment (each keeps its order). */
function byEnv<T extends { environmentId?: string }>(sorted: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of sorted) {
    const env = envIdOf(item);
    const list = out.get(env);
    if (list) list.push(item);
    else out.set(env, [item]);
  }
  return out;
}

/** Client-order list names (`state/env-order.ts`). */
export const PROJECT_ORDER = "projects";
export const pinOrderList = (projectId: string | null) => `pins:${projectId ?? "standalone"}`;
/** A list's mixed order of chats and folders (I-202). */
export const chatOrderList = (projectId: string | null) => `chats:${projectId ?? "standalone"}`;

/**
 * Projects in their manual order: each environment's server order (`sortOrder`), interleaved
 * across environments as this device arranged them (never re-sorted by activity). Projects are
 * always top level (I-202).
 */
export const sortedProjects = computed(() => interleave(clientOrders.value[PROJECT_ORDER] ?? [], byEnv([...projects.value].sort(compareProjects)), envOrder()));

/** A project's folders in their order (I-165); `null`: the Chats section's (I-202). */
export function foldersForProject(projectId: string | null): Folder[] {
  return foldersOfProject(folders.value, projectId);
}

/** The folder a chat is shown in, or null (unknown / mismatched folder ids count as none). */
export function folderOfWorkspace(workspace: WorkspaceSummary): string | null {
  return workspaceFolderId(workspace, foldersById.value, envIdOf);
}

/**
 * A list as shown (I-202): a project's (or, `null`, the Chats section's) pinned chats outside
 * folders, then its chats and folders in one manual order, each folder with its chats.
 */
export function chatListOf(projectId: string | null): ChatListView<WorkspaceSummary> {
  return buildChatList({
    chats: workspaces.value.filter((w) => w.projectId === projectId),
    folders: folders.value.filter((f) => f.projectId === projectId),
    foldersById: foldersById.value,
    envOf: envIdOf,
    pinSlots: clientOrders.value[pinOrderList(projectId)] ?? [],
    orderSlots: clientOrders.value[chatOrderList(projectId)] ?? [],
    envOrder: envOrder(),
  });
}

/** A list's chats that aren't in a folder (pinned first, then their manual order). */
export function looseWorkspaces(projectId: string | null): WorkspaceSummary[] {
  const view = chatListOf(projectId);
  return [...view.pinned, ...view.entries.flatMap((e) => (e.kind === "chat" ? [e.chat] : []))];
}

/** The chats in a folder (pinned first, then their manual order). */
export function workspacesInFolder(folderId: string): WorkspaceSummary[] {
  const folder = foldersById.value.get(folderId);
  if (!folder) return [];
  const entry = chatListOf(folder.projectId).entries.find((e) => e.kind === "folder" && e.folder.id === folderId);
  return entry?.kind === "folder" ? entry.chats : [];
}

/** Every chat of a list in display order (pinned, then the mixed order with folders' chats in place). */
export function workspacesForProject(projectId: string | null): WorkspaceSummary[] {
  return chatsOfView(chatListOf(projectId));
}

/** Keys of items for the client order (`envId:id`). */
export const itemOrderKey = (item: { id: string; environmentId?: string }) => orderKey(envIdOf(item), item.id);

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

/** Environments whose sync snapshot of the shell was applied (I-122): newer than any HTTP list. */
const shellSynced = new Set<string>();

/** The client of an environment (the local `api` for untagged/unknown). */
function clientOf(envId?: string | null) {
  return (envId ? connectionFor(envId) : undefined) ?? null;
}

/** Tag server items with their environment (untagged when `envId` is undefined: local/tests). */
function tagAll<T extends { environmentId?: string }>(items: T[], envId: string | undefined): T[] {
  return envId === undefined ? items : items.map((i) => (i.environmentId === envId ? i : { ...i, environmentId: envId }));
}
function tag<T extends { environmentId?: string }>(item: T, envId: string | undefined): T {
  return envId === undefined || item.environmentId === envId ? item : { ...item, environmentId: envId };
}

/** `list` with the items of `envId` (primary when undefined) replaced by `next`. */
function replaceEnv<T extends { environmentId?: string }>(list: T[], envId: string | undefined, next: T[]): T[] {
  const env = envId ?? primaryEnvironmentId();
  return [...list.filter((i) => envIdOf(i) !== env), ...next];
}

/**
 * Load one environment's shell over HTTP (first paint; the sync snapshot replaces it). Without
 * `envId`: every connected environment (or the local server when none is registered yet).
 */
export async function loadAll(envId?: string): Promise<void> {
  if (envId === undefined && connections.value.length > 0) {
    await Promise.all(connections.value.map((c) => loadAll(c.id)));
    return;
  }
  const conn = clientOf(envId);
  const client = conn?.api ?? api;
  const shell = conn?.shell ?? localShell;
  const key = envId ?? primaryEnvironmentId();
  try {
    const [p, w, ss, s, f] = await Promise.all([
      client.listProjects(),
      client.listWorkspaces(),
      client.listSessions(),
      client.getSettings(),
      // Older servers have no folders (I-165).
      Promise.resolve()
        .then(() => client.listFolders())
        .catch(() => [] as Folder[]),
    ]);
    if (!shellSynced.has(key) && (envId === undefined || connectionFor(envId))) {
      projects.value = replaceEnv(projects.value, envId, tagAll(p, envId));
      folders.value = replaceEnv(folders.value, envId, tagAll(f, envId));
      workspaces.value = replaceEnv(workspaces.value, envId, tagAll(w, envId));
      sessions.value = replaceEnv(sessions.value, envId, tagAll(ss, envId));
      shell.settings.value = s;
    }
    shell.initError.value = null;
  } catch (err) {
    shell.initError.value = (err as Error).message;
  } finally {
    shell.initialized.value = true;
  }
  // Models can be slow (spawns the agent); don't block the UI on them.
  void loadModels(false, envId);
  void loadHarnesses(envId);
}

export async function loadModels(refresh = false, envId?: string): Promise<void> {
  const conn = clientOf(envId);
  const shell = conn?.shell ?? localShell;
  // Same utility process on the server (shared in-flight request), so a refresh updates both.
  const defaults = Promise.resolve()
    .then(() => getHarnessDefaults(refresh, conn?.request ?? request))
    .then(
    (d) => {
      shell.harnessDefaults.value = d;
    },
    () => {
      /* not fatal: "Default" then falls back to the first model */
    },
  );
  // Other agents' defaults already asked for (I-198) are re-read with a refresh too.
  if (refresh) for (const harness of agentDefaults.get(shell)?.keys() ?? []) void loadAgentDefaults(harness, envId, true);
  try {
    shell.models.value = await (conn?.api ?? api).listModels(refresh);
  } catch (err) {
    // A remote environment that refused this device shows "Needs pairing" instead (I-125).
    const { status, code } = err as { status?: number; code?: string };
    if (status === 401 || code === "remote_disabled") return;
    // A remote one we can't reach (asleep, offline): its status says so in the list; no toast
    // per unreachable Mac (I-164: the iPhone showed one for each on launch).
    if (status === undefined && conn && !conn.isLocal) return;
    notify("error", `Could not load models: ${(err as Error).message}`);
  }
  await defaults;
}

/** The settings that change which harnesses an environment offers (I-155, I-159). */
export function agentSettingsKey(s: Settings): string {
  return JSON.stringify([s.agents ?? {}, s.agent?.defaultHarness ?? null]);
}

export function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [...list, item];
  const copy = list.slice();
  copy[idx] = item;
  return copy;
}

/** The shell scope's snapshot (I-122) of one environment: replaces its lists and settings. */
export function applyShellSnapshot(shell: ShellSnapshot, envId?: string): void {
  shellSynced.add(envId ?? primaryEnvironmentId());
  const target = shellOf(envId);
  const before = new Map(sessions.value.map((s) => [s.id, s]));
  projects.value = replaceEnv(projects.value, envId, tagAll(shell.projects, envId));
  workspaces.value = replaceEnv(workspaces.value, envId, tagAll(shell.workspaces, envId));
  sessions.value = replaceEnv(sessions.value, envId, tagAll(shell.sessions, envId));
  folders.value = replaceEnv(folders.value, envId, tagAll(shell.folders ?? [], envId));
  const acpChanged = agentSettingsKey(target.settings.value) !== agentSettingsKey(shell.settings);
  target.settings.value = shell.settings;
  if (shell.environment) {
    const conn = envId ? connectionFor(envId) : undefined;
    if (conn) conn.info.value = shell.environment;
  }
  if (acpChanged) void loadHarnesses(envId);
  target.initError.value = null;
  target.initialized.value = true;
  for (const session of shell.sessions) reloadIfChangedElsewhere(before.get(session.id), session);
}

/**
 * After catching up (I-122), one environment's lists are checked against every id its server
 * has: ours that it doesn't have are dropped. Returns true when the server has some we don't
 * (take a snapshot).
 */
export function applyShellCheck(check: { projects: string[]; workspaces: string[]; sessions: string[]; folders?: string[] }, envId?: string): boolean {
  const env = envId ?? primaryEnvironmentId();
  const ids = { projects: new Set(check.projects), workspaces: new Set(check.workspaces), sessions: new Set(check.sessions) };
  const prune = <T extends { id: string; environmentId?: string }>(list: T[], keep: Set<string>) =>
    list.every((x) => envIdOf(x) !== env || keep.has(x.id)) ? list : list.filter((x) => envIdOf(x) !== env || keep.has(x.id));
  projects.value = prune(projects.value, ids.projects);
  workspaces.value = prune(workspaces.value, ids.workspaces);
  sessions.value = prune(sessions.value, ids.sessions);
  if (check.folders) folders.value = prune(folders.value, new Set(check.folders));
  const count = (list: Array<{ environmentId?: string }>) => list.filter((x) => envIdOf(x) === env).length;
  return (
    count(projects.value) < ids.projects.size ||
    count(workspaces.value) < ids.workspaces.size ||
    count(sessions.value) < ids.sessions.size ||
    (check.folders !== undefined && count(folders.value) < check.folders.length)
  );
}

/** An environment was disconnected (remote access off, removed): hide its items (nothing is deleted). */
export function removeEnvironmentItems(envId: string): void {
  shellSynced.delete(envId);
  const keep = <T extends { environmentId?: string }>(list: T[]) => (list.some((x) => envIdOf(x) === envId) ? list.filter((x) => envIdOf(x) !== envId) : list);
  projects.value = keep(projects.value);
  workspaces.value = keep(workspaces.value);
  sessions.value = keep(sessions.value);
  folders.value = keep(folders.value);
}

/** Tests: forget that a snapshot was applied. */
export function resetShellSync(): void {
  shellSynced.clear();
}

/** A shell push from an environment (`envId` undefined: the local one, untagged). */
export function handleServerMessage(message: ServerMessage, envId?: string): void {
  switch (message.type) {
    case "workspace_upsert":
      workspaces.value = upsert(workspaces.value, tag(message.workspace, envId));
      break;
    case "workspace_removed":
      workspaces.value = workspaces.value.filter((w) => w.id !== message.workspaceId);
      sessions.value = sessions.value.filter((s) => s.workspaceId !== message.workspaceId);
      break;
    case "session_upsert": {
      const previous = sessions.value.find((s) => s.id === message.session.id);
      const session = tag(message.session, envId);
      sessions.value = upsert(sessions.value, session);
      reloadIfChangedElsewhere(previous, session);
      break;
    }
    case "session_removed":
      sessions.value = sessions.value.filter((s) => s.id !== message.sessionId);
      break;
    case "project_upsert":
      projects.value = upsert(projects.value, tag(message.project, envId));
      break;
    case "project_removed":
      projects.value = projects.value.filter((p) => p.id !== message.projectId);
      break;
    case "folder_upsert":
      folders.value = upsert(folders.value, tag(message.folder, envId));
      break;
    case "folder_removed":
      folders.value = folders.value.filter((f) => f.id !== message.folderId);
      break;
    case "settings": {
      // ACP agents added/removed (I-119) or agents turned on/off (I-155), maybe in another
      // window or on the host itself: the harness list changes with them.
      const target = shellOf(envId);
      const acpChanged = agentSettingsKey(target.settings.value) !== agentSettingsKey(message.settings);
      target.settings.value = message.settings;
      if (acpChanged) void loadHarnesses(envId);
      break;
    }
    case "models":
      shellOf(envId).models.value = message.models;
      break;
    case "environment": {
      const conn = connectionFor(envId);
      if (conn) conn.info.value = message.environment;
      break;
    }
    case "session_event":
      handleSessionEvent(message.sessionId, message.event);
      break;
    case "usage_limits":
      // Each Mac's own accounts (I-191): a chat shows the limits of the Mac it runs on.
      handleUsageMessage(message, envId);
      break;
    case "local_models":
      // Each Mac's own model server (I-196).
      handleLocalModelsMessage(message.state, envId);
      break;
    case "open_chat":
      requestOpenChat(message);
      break;
    case "hello":
      break;
  }
}
