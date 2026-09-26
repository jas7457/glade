import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deepMerge, defaultSettings, type DeepPartial, type Project, type Session, type Settings, type Workspace } from "@pi-ui/protocol";
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

/**
 * pi-ui's own persistent data: projects, the workspace + session index, and settings.
 * Stored as JSON under the app data dir; see docs/ARCHITECTURE.md.
 */
export class Store {
  private readonly projectsFile: JsonFile<ProjectsFile>;
  private readonly workspacesFile: JsonFile<WorkspacesFile>;
  private readonly settingsFile: JsonFile<DeepPartial<Settings>>;

  constructor(dataDir: string, debounceMs = 50) {
    this.projectsFile = new JsonFile(join(dataDir, "projects.json"), () => ({ version: 1, projects: [] }), debounceMs);
    const workspacesPath = join(dataDir, "workspaces.json");
    const hadWorkspaces = existsSync(workspacesPath);
    this.workspacesFile = new JsonFile(workspacesPath, () => ({ version: 1, workspaces: [], sessions: [] }), debounceMs);
    if (!hadWorkspaces) this.migrateLegacyChats(join(dataDir, "chats.json"));
    this.settingsFile = new JsonFile(join(dataDir, "settings.json"), () => ({}), debounceMs);
    this.migrate();
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
        console.warn(`[pi-ui] could not migrate ${chatsPath}: ${(err as Error).message}`);
      }
      return;
    }
    this.workspacesFile.set({ version: 1, ...migrateChats(chats) });
    this.workspacesFile.flush();
  }

  /**
   * Upgrade data written by older versions (I-019): projects get a manual `sortOrder` (from their
   * previous order: pinned first, then most recently active) and lose `pinned`; pinned chats get
   * a `pinOrder` the same way, per list. Writes only when something changed.
   */
  private migrate(): void {
    // I-028: system notifications were removed; drop the old toggle from stored settings.
    const storedSettings = this.settingsFile.get() as { general?: Record<string, unknown> };
    if (storedSettings.general && "notifyOnComplete" in storedSettings.general) {
      const { notifyOnComplete: _removed, ...general } = storedSettings.general;
      this.settingsFile.set({ ...storedSettings, general } as DeepPartial<Settings>);
    }

    /** Shape of projects written before I-019 (may have `pinned`, may lack `sortOrder`). */
    type LegacyProject = Project & { pinned?: boolean };
    const projects = this.listProjects() as LegacyProject[];
    if (projects.some((p) => typeof p.sortOrder !== "number" || "pinned" in p)) {
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
      this.projectsFile.set({ version: 1, projects: migrated });
    }

    const workspaces = this.listWorkspaces();
    const needsPinOrder = (w: Workspace) => w.pinned && typeof w.pinOrder !== "number";
    const strayPinOrder = (w: Workspace) => !w.pinned && w.pinOrder !== undefined;
    if (workspaces.some((w) => needsPinOrder(w) || strayPinOrder(w))) {
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
      this.workspacesFile.set({ ...this.workspacesFile.get(), workspaces: migrated });
    }
  }

  // Projects ----------------------------------------------------------------------------------

  listProjects(): Project[] {
    return this.projectsFile.get().projects;
  }

  getProject(id: string): Project | undefined {
    return this.listProjects().find((p) => p.id === id);
  }

  upsertProject(project: Project): Project {
    const projects = this.listProjects().filter((p) => p.id !== project.id);
    this.projectsFile.set({ version: 1, projects: [...projects, project] });
    return project;
  }

  removeProject(id: string): void {
    this.projectsFile.set({ version: 1, projects: this.listProjects().filter((p) => p.id !== id) });
  }

  // Workspaces ---------------------------------------------------------------------------------

  listWorkspaces(): Workspace[] {
    return this.workspacesFile.get().workspaces;
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.listWorkspaces().find((w) => w.id === id);
  }

  upsertWorkspace(workspace: Workspace): Workspace {
    const file = this.workspacesFile.get();
    this.workspacesFile.set({ ...file, workspaces: replaceOrAppend(file.workspaces, workspace) });
    return workspace;
  }

  /** Removes the workspace and all of its sessions. */
  removeWorkspace(id: string): void {
    const file = this.workspacesFile.get();
    this.workspacesFile.set({
      ...file,
      workspaces: file.workspaces.filter((w) => w.id !== id),
      sessions: file.sessions.filter((s) => s.workspaceId !== id),
    });
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
    const file = this.workspacesFile.get();
    this.workspacesFile.set({ ...file, sessions: replaceOrAppend(file.sessions, session) });
    return session;
  }

  removeSession(id: string): void {
    const file = this.workspacesFile.get();
    this.workspacesFile.set({ ...file, sessions: file.sessions.filter((s) => s.id !== id) });
  }

  // Settings ----------------------------------------------------------------------------------

  /** Effective settings (defaults merged with the stored overrides). */
  getSettings(): Settings {
    return deepMerge(defaultSettings(), this.settingsFile.get());
  }

  updateSettings(patch: DeepPartial<Settings>): Settings {
    this.settingsFile.set(deepMerge(this.settingsFile.get() as Settings, patch));
    return this.getSettings();
  }

  flush(): void {
    this.projectsFile.flush();
    this.workspacesFile.flush();
    this.settingsFile.flush();
  }
}

function replaceOrAppend<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  return idx === -1 ? [...list, item] : list.map((x, i) => (i === idx ? item : x));
}
