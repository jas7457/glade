import { join } from "node:path";
import { deepMerge, defaultSettings, type Chat, type DeepPartial, type Project, type Settings } from "@pi-ui/protocol";
import { JsonFile } from "./json-file.js";

interface ProjectsFile {
  version: 1;
  projects: Project[];
}

interface ChatsFile {
  version: 1;
  chats: Chat[];
}

/**
 * pi-ui's own persistent data: projects, the chat index, and settings.
 * Stored as JSON under the app data dir; see docs/ARCHITECTURE.md.
 */
export class Store {
  private readonly projectsFile: JsonFile<ProjectsFile>;
  private readonly chatsFile: JsonFile<ChatsFile>;
  private readonly settingsFile: JsonFile<DeepPartial<Settings>>;

  constructor(dataDir: string, debounceMs = 50) {
    this.projectsFile = new JsonFile(join(dataDir, "projects.json"), () => ({ version: 1, projects: [] }), debounceMs);
    this.chatsFile = new JsonFile(join(dataDir, "chats.json"), () => ({ version: 1, chats: [] }), debounceMs);
    this.settingsFile = new JsonFile(join(dataDir, "settings.json"), () => ({}), debounceMs);
    this.migrate();
  }

  /**
   * Upgrade data written by older versions (I-019): projects get a manual `sortOrder` (from their
   * previous order: pinned first, then most recently active) and lose `pinned`; pinned chats get
   * a `pinOrder` the same way, per list. Writes only when something changed.
   */
  private migrate(): void {
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

    const chats = this.listChats();
    const needsPinOrder = (c: Chat) => c.pinned && typeof c.pinOrder !== "number";
    const strayPinOrder = (c: Chat) => !c.pinned && c.pinOrder !== undefined;
    if (chats.some((c) => needsPinOrder(c) || strayPinOrder(c))) {
      const assigned = new Map<string, number>();
      for (const listId of new Set(chats.map((c) => c.projectId))) {
        const pinned = chats.filter((c) => c.projectId === listId && c.pinned);
        const ordered = pinned.filter((c) => typeof c.pinOrder === "number");
        let next = ordered.length ? Math.max(...ordered.map((c) => c.pinOrder!)) + 1 : 0;
        for (const c of pinned.filter(needsPinOrder).sort((a, b) => b.lastActivityAt - a.lastActivityAt)) {
          assigned.set(c.id, next++);
        }
      }
      const migrated = chats.map((c) => {
        if (strayPinOrder(c)) {
          const { pinOrder: _pinOrder, ...rest } = c;
          return rest;
        }
        return assigned.has(c.id) ? { ...c, pinOrder: assigned.get(c.id)! } : c;
      });
      this.chatsFile.set({ version: 1, chats: migrated });
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

  // Chats -------------------------------------------------------------------------------------

  listChats(): Chat[] {
    return this.chatsFile.get().chats;
  }

  getChat(id: string): Chat | undefined {
    return this.listChats().find((c) => c.id === id);
  }

  upsertChat(chat: Chat): Chat {
    const chats = this.listChats();
    const idx = chats.findIndex((c) => c.id === chat.id);
    const next = idx === -1 ? [...chats, chat] : chats.map((c, i) => (i === idx ? chat : c));
    this.chatsFile.set({ version: 1, chats: next });
    return chat;
  }

  removeChat(id: string): void {
    this.chatsFile.set({ version: 1, chats: this.listChats().filter((c) => c.id !== id) });
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
    this.chatsFile.flush();
    this.settingsFile.flush();
  }
}
