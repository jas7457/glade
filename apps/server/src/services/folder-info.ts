/**
 * Folder-level info that doesn't need a chat (I-043, I-044, I-050): the harness's slash commands
 * for a project/scratch folder, file search for `@` mentions, and the harness's default model.
 * Results are cached per folder for a short time; concurrent requests share one fetch.
 *
 * Only folders pi-ui knows (a project's path or the scratch folder) are ever listed: callers pass
 * a project id, never a path.
 */
import type { FileSearchResponse, HarnessDefaults, SlashCommand } from "@pi-ui/protocol";
import type { AgentHarness } from "../harness/types.js";
import { HttpError } from "./app-service.js";
import { listFolderFiles, rankFiles, type FolderFiles } from "./file-index.js";

export interface FolderInfoOptions {
  harness: AgentHarness;
  /** Folder of standalone chats. */
  scratchDir: string;
  /** A project's folder, or `undefined` for an unknown project. */
  projectPath: (projectId: string) => string | undefined;
  /** How long folder commands stay cached (default 60 s). */
  commandsTtlMs?: number;
  /** How long a file listing stays cached (default 10 s). */
  filesTtlMs?: number;
  /** File listing (injectable for tests). */
  listFiles?: (cwd: string) => Promise<FolderFiles>;
}

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

export const DEFAULT_FILE_LIMIT = 50;
const MAX_FILE_LIMIT = 200;

export class FolderInfoService {
  private readonly commands = new Map<string, CacheEntry<SlashCommand[]>>();
  private readonly files = new Map<string, CacheEntry<FolderFiles>>();

  constructor(private readonly options: FolderInfoOptions) {}

  /** The folder for `projectId` (`null`/empty = scratch). 404 for unknown projects. */
  folderFor(projectId: string | null | undefined): string {
    if (!projectId) return this.options.scratchDir;
    const path = this.options.projectPath(projectId);
    if (!path) throw new HttpError(404, "Project not found");
    return path;
  }

  /** Harness commands (extensions, skills, prompts) available in the folder. */
  async listCommands(projectId: string | null, force = false): Promise<SlashCommand[]> {
    const cwd = this.folderFor(projectId);
    const harness = this.options.harness;
    if (!harness.listFolderCommands) return [];
    return this.cached(this.commands, cwd, this.options.commandsTtlMs ?? 60_000, force, () => harness.listFolderCommands!(cwd));
  }

  /** Files/folders of the folder matching `query`, best first. */
  async searchFiles(projectId: string | null, query: string, limit = DEFAULT_FILE_LIMIT): Promise<FileSearchResponse> {
    const cwd = this.folderFor(projectId);
    const list = this.options.listFiles ?? listFolderFiles;
    const { entries, truncated } = await this.cached(this.files, cwd, this.options.filesTtlMs ?? 10_000, false, () => list(cwd));
    const cap = Math.max(1, Math.min(MAX_FILE_LIMIT, Math.floor(limit) || DEFAULT_FILE_LIMIT));
    return { entries: rankFiles(entries, query, cap), truncated };
  }

  /** The harness's own default model/thinking level (`null`s when it can't tell). */
  async getDefaults(force = false): Promise<HarnessDefaults> {
    return (await this.options.harness.getDefaults?.(force)) ?? { model: null, thinkingLevel: null };
  }

  private cached<T>(map: Map<string, CacheEntry<T>>, key: string, ttl: number, force: boolean, load: () => Promise<T>): Promise<T> {
    const hit = map.get(key);
    if (hit && !force && Date.now() - hit.at < ttl) return hit.value;
    const value = load();
    const entry = { at: Date.now(), value };
    map.set(key, entry);
    // Failures aren't cached.
    value.catch(() => {
      if (map.get(key) === entry) map.delete(key);
    });
    return value;
  }
}
