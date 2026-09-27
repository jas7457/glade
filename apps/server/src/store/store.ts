import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deepMerge, defaultSettings, type DeepPartial, type Project, type Session, type Settings, type Workspace } from "@glade/protocol";
import { DataDirWatcher, type Reloadable } from "./dir-watcher.js";
import { JsonFile } from "./json-file.js";
import { migrateChats, type LegacyChat } from "./migrate-workspaces.js";

interface ProjectsFile {
  version: 1;
  projects: Project[];
}

interface WorkspacesFile {
  version: 1;
  workspaces: Workspace[];
  sessions: Session[];
}

/** What another server changed in the shared files (I-062), found by diffing before/after. */
export interface StoreChange {
  projects: { upserted: Project[]; removed: string[] };
  workspaces: { upserted: Workspace[]; removed: string[] };
  /** Removed sessions are the last known records (callers need their workspace). */
  sessions: { upserted: Session[]; removed: Session[] };
  settings: boolean;
}

/**
 * Glade's own persistent data: projects, the workspace + session index, and settings.
 * Stored as JSON under the app data dir; see docs/ARCHITECTURE.md.
 *
 * Several servers may share the folder (I-062): every change is a read-modify-write under the
 * file's lock (JsonFile), and `watch()` picks up what the others write and reports it to
 * `onExternalChange` listeners (the AppService pushes it to its clients).
 */
export class Store {
  private readonly projectsFile: JsonFile<ProjectsFile>;
  private readonly workspacesFile: JsonFile<WorkspacesFile>;
  private readonly settingsFile: JsonFile<DeepPartial<Settings>>;
  private readonly watcher: DataDirWatcher;
  private readonly changeListeners = new Set<(change: StoreChange) => void>();

  constructor(
    readonly dataDir: string,
    debounceMs = 50,
  ) {
    this.projectsFile = new JsonFile<ProjectsFile>(join(dataDir, "projects.json"), () => ({ version: 1, projects: [] }), debounceMs);
    const workspacesPath = join(dataDir, "workspaces.json");
    const hadWorkspaces = existsSync(workspacesPath);
    this.workspacesFile = new JsonFile<WorkspacesFile>(workspacesPath, () => ({ version: 1, workspaces: [], sessions: [] }), debounceMs);
    if (!hadWorkspaces) this.migrateLegacyChats(join(dataDir, "chats.json"));
    this.settingsFile = new JsonFile<DeepPartial<Settings>>(join(dataDir, "settings.json"), () => ({}), debounceMs);
    this.migrate();
    this.watcher = new DataDirWatcher(dataDir);
    for (const file of [this.projectsFile, this.workspacesFile, this.settingsFile]) this.watcher.add(file);
    this.projectsFile.onExternalChange((before, after) =>
      this.emitChange({ projects: diffById(before.projects, after.projects, (p) => p.id) }),
    );
    this.workspacesFile.onExternalChange((before, after) => {
      const sessions = diffById(before.sessions, after.sessions, (s) => s.id);
      const removedIds = new Set(sessions.removed);
      this.emitChange({
        workspaces: diffById(before.workspaces, after.workspaces, (w) => w.id),
        sessions: { upserted: sessions.upserted, removed: before.sessions.filter((s) => removedIds.has(s.id)) },
      });
    });
    this.settingsFile.onExternalChange(() => this.emitChange({ settings: true }));
  }

  // Sharing with other servers (I-062) -------------------------------------------------------

  /** Start watching the data folder for other servers' writes. */
  watch(): void {
    this.watcher.start();
  }

  /** Also watch another shared file of this folder (e.g. `agents.json`). */
  watchFile(file: Reloadable): void {
    this.watcher.add(file);
  }

  /** Re-read every watched file now (tests; the watcher does this on its own). */
  reload(): void {
    this.watcher.checkAll();
  }

  onExternalChange(listener: (change: StoreChange) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(partial: Partial<StoreChange>): void {
    const change: StoreChange = {
      projects: partial.projects ?? { upserted: [], removed: [] },
      workspaces: partial.workspaces ?? { upserted: [], removed: [] },
      sessions: partial.sessions ?? { upserted: [], removed: [] },
      settings: partial.settings ?? false,
    };
    for (const listener of this.changeListeners) listener(change);
  }

  /**
   * I-035: turn the old `chats.json` into workspaces + sessions (see migrate-workspaces.ts). Runs
   * only while `workspaces.json` doesn't exist yet, so it happens once; `chats.json` is left
   * untouched (no longer read) as a backup.
   */
  private migrateLegacyChats(chatsPath: string): void {
    let chats: LegacyChat[];
    try {
      chats = (JSON.parse(readFileSync(chatsPath, "utf8")) as { chats?: LegacyChat[] }).chats ?? [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // Don't create an empty workspaces.json over data we couldn't read; retry next start.
        console.warn(`[glade] could not migrate ${chatsPath}: ${(err as Error).message}`);
      }
      return;
    }
    const migrated = migrateChats(chats);
    // Another server may have migrated (and started writing) meanwhile: only fill an empty index.
    this.workspacesFile.update((file) => (file.workspaces.length || file.sessions.length ? file : { version: 1, ...migrated }));
    this.workspacesFile.flush();
  }

  /**
   * Upgrade data written by older versions (I-019): projects get a manual `sortOrder` (from their
   * previous order: pinned first, then most recently active) and lose `pinned`; pinned chats get
   * a `pinOrder` the same way, per list. Writes only when something changed.
   */
  private migrate(): void {
    // Each migration is a pure function of the file's content, so it's safe to replay on top of
    // what another server wrote (I-062); it only runs when it would change something.
    const settings = this.settingsFile.get();
    if (migrateSettings(settings) !== settings) this.settingsFile.update(migrateSettings);
    const projects = this.projectsFile.get();
    if (migrateProjects(projects) !== projects) this.projectsFile.update(migrateProjects);
    const workspaces = this.workspacesFile.get();
    if (migratePinOrder(workspaces) !== workspaces) this.workspacesFile.update(migratePinOrder);
  }

  // Projects ----------------------------------------------------------------------------------

  listProjects(): Project[] {
    return this.projectsFile.get().projects;
  }

  getProject(id: string): Project | undefined {
    return this.listProjects().find((p) => p.id === id);
  }

  upsertProject(project: Project): Project {
    this.projectsFile.update((file) => ({ ...file, version: 1, projects: [...file.projects.filter((p) => p.id !== project.id), project] }));
    return project;
  }

  removeProject(id: string): void {
    this.projectsFile.update((file) => ({ ...file, version: 1, projects: file.projects.filter((p) => p.id !== id) }));
  }

  // Workspaces ---------------------------------------------------------------------------------

  listWorkspaces(): Workspace[] {
    return this.workspacesFile.get().workspaces;
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.listWorkspaces().find((w) => w.id === id);
  }

  upsertWorkspace(workspace: Workspace): Workspace {
    this.workspacesFile.update((file) => ({ ...file, workspaces: replaceOrAppend(file.workspaces, workspace) }));
    return workspace;
  }

  /** Removes the workspace and all of its sessions. */
  removeWorkspace(id: string): void {
    this.workspacesFile.update((file) => ({
      ...file,
      workspaces: file.workspaces.filter((w) => w.id !== id),
      sessions: file.sessions.filter((s) => s.workspaceId !== id),
    }));
  }

  // Sessions -----------------------------------------------------------------------------------

  /** All sessions, or those of one workspace. */
  listSessions(workspaceId?: string): Session[] {
    const all = this.workspacesFile.get().sessions;
    return workspaceId === undefined ? all : all.filter((s) => s.workspaceId === workspaceId);
  }

  getSession(id: string): Session | undefined {
    return this.workspacesFile.get().sessions.find((s) => s.id === id);
  }

  upsertSession(session: Session): Session {
    this.workspacesFile.update((file) => ({ ...file, sessions: replaceOrAppend(file.sessions, session) }));
    return session;
  }

  removeSession(id: string): void {
    this.workspacesFile.update((file) => ({ ...file, sessions: file.sessions.filter((s) => s.id !== id) }));
  }

  // Settings ----------------------------------------------------------------------------------

  /** Effective settings (defaults merged with the stored overrides). */
  getSettings(): Settings {
    return deepMerge(defaultSettings(), this.settingsFile.get());
  }

  updateSettings(patch: DeepPartial<Settings>): Settings {
    this.settingsFile.update((stored) => deepMerge(stored as Settings, patch));
    return this.getSettings();
  }

  flush(): void {
    this.projectsFile.flush();
    this.workspacesFile.flush();
    this.settingsFile.flush();
  }

  /** Stop watching and write what's pending. */
  dispose(): void {
    this.watcher.stop();
    this.flush();
  }
}

/** Records added/changed (by JSON) and ids removed between two lists. */
function diffById<T>(before: readonly T[], after: readonly T[], id: (item: T) => string): { upserted: T[]; removed: string[] } {
  const old = new Map(before.map((item) => [id(item), JSON.stringify(item)]));
  const upserted = after.filter((item) => old.get(id(item)) !== JSON.stringify(item));
  const kept = new Set(after.map(id));
  return { upserted, removed: [...old.keys()].filter((key) => !kept.has(key)) };
}

function replaceOrAppend<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  return idx === -1 ? [...list, item] : list.map((x, i) => (i === idx ? item : x));
}

/** I-028: system notifications were removed; drop the old toggle from stored settings. */
function migrateSettings(stored: DeepPartial<Settings>): DeepPartial<Settings> {
  const general = (stored as { general?: Record<string, unknown> }).general;
  if (!general || !("notifyOnComplete" in general)) return stored;
  const { notifyOnComplete: _removed, ...rest } = general;
  return { ...stored, general: rest } as DeepPartial<Settings>;
}

/**
 * I-019: projects get a manual `sortOrder` (from their previous order: pinned first, then most
 * recently active) and lose `pinned`. Returns the same object when nothing changes.
 */
function migrateProjects(file: ProjectsFile): ProjectsFile {
  /** Shape of projects written before I-019 (may have `pinned`, may lack `sortOrder`). */
  type LegacyProject = Project & { pinned?: boolean };
  const projects = file.projects as LegacyProject[];
  if (!projects.some((p) => typeof p.sortOrder !== "number" || "pinned" in p)) return file;
  const byPrevious = (a: LegacyProject, b: LegacyProject) =>
    Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.lastActivityAt - a.lastActivityAt;
  const ordered = projects.filter((p) => typeof p.sortOrder === "number");
  let next = ordered.length ? Math.max(...ordered.map((p) => p.sortOrder)) + 1 : 0;
  const missing = new Map(
    projects
      .filter((p) => typeof p.sortOrder !== "number")
      .sort(byPrevious)
      .map((p) => [p.id, next++] as const),
  );
  const migrated = projects.map(({ pinned: _pinned, ...p }) => ({ ...p, sortOrder: missing.get(p.id) ?? p.sortOrder }));
  return { version: 1, projects: migrated };
}

/** I-019: pinned chats get a `pinOrder` per list (most recent activity first); unpinned lose it. */
function migratePinOrder(file: WorkspacesFile): WorkspacesFile {
  const workspaces = file.workspaces;
  const needsPinOrder = (w: Workspace) => w.pinned && typeof w.pinOrder !== "number";
  const strayPinOrder = (w: Workspace) => !w.pinned && w.pinOrder !== undefined;
  if (!workspaces.some((w) => needsPinOrder(w) || strayPinOrder(w))) return file;
  const assigned = new Map<string, number>();
  for (const listId of new Set(workspaces.map((w) => w.projectId))) {
    const pinned = workspaces.filter((w) => w.projectId === listId && w.pinned);
    const ordered = pinned.filter((w) => typeof w.pinOrder === "number");
    let next = ordered.length ? Math.max(...ordered.map((w) => w.pinOrder!)) + 1 : 0;
    for (const w of pinned.filter(needsPinOrder).sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
      assigned.set(w.id, next++);
    }
  }
  const migrated = workspaces.map((w) => {
    if (strayPinOrder(w)) {
      const { pinOrder: _pinOrder, ...rest } = w;
      return rest;
    }
    return assigned.has(w.id) ? { ...w, pinOrder: assigned.get(w.id)! } : w;
  });
  return { ...file, workspaces: migrated };
}
