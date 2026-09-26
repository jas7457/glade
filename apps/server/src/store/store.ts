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
