/**
 * Folder-level info that doesn't need a chat (I-043, I-044, I-050): the harness's slash commands
 * for a project/scratch folder, file search for `@` mentions, and the harness's default model.
 * Results are cached per folder for a short time; concurrent requests share one fetch.
 *
 * Everything here is for new chats, so it asks the agent picked in the new-chat composer (I-185:
 * `harnessId`), else the default harness (I-064), read per call so a changed default applies at
 * once. The permission modes a new chat can start in (I-184) come from here too.
 *
 * Which folder (I-213), first match wins: a chat's `workspaceId` (its `cwd`; 404 when unknown), an
 * explicit `folder` (checked like a group chat's folder: an existing folder inside the folder
 * browser's area, else 400), a `projectId` (its path; 404 when unknown), else the scratch folder.
 * A group project (`path: null`) alone has no folder: no commands, no files, and the permission
 * modes of the scratch folder (the agent's defaults).
 */
import type { FileSearchResponse, FolderPermissionModes, HarnessDefaults, ModelRef, SlashCommand } from "@glade/protocol";
import type { AgentHarness } from "../harness/types.js";
import { HttpError } from "./app-service.js";
import { listFolderFiles, rankFiles, type FolderFiles } from "./file-index.js";

export interface FolderInfoOptions {
  /**
   * The harness with this id when this device offers it (`undefined` otherwise); without an id,
   * the one new chats use by default (`HarnessRegistry.default`).
   */
  harness: (id?: string) => AgentHarness | undefined;
  /** Folder of standalone chats. */
  scratchDir: string;
  /** A project's folder, `null` for a group project (I-213), `undefined` for an unknown project. */
  projectPath: (projectId: string) => string | null | undefined;
  /** A chat's folder (`Workspace.cwd`), `undefined` when unknown (I-213). Default: none known. */
  workspaceCwd?: (workspaceId: string) => string | undefined;
  /**
   * Checks an explicit folder and returns its real path, throwing `HttpError` 400 otherwise (I-213).
   * Default: explicit folders are refused.
   */
  resolveFolder?: (folder: string) => Promise<string>;
  /** How long folder commands stay cached (default 60 s). */
  commandsTtlMs?: number;
  /** How long a folder's permission modes stay cached (default 60 s). */
  modesTtlMs?: number;
  /** How long a file listing stays cached (default 10 s). */
  filesTtlMs?: number;
  /** File listing (injectable for tests). */
  listFiles?: (cwd: string) => Promise<FolderFiles>;
}

interface CacheEntry<T> {
  at: number;
  value: Promise<T>;
}

/**
 * Which folder a request is about (I-213): a project id (`null`/empty = scratch), or an object
 * that may also name a chat (`workspaceId`) or an explicit `folder`.
 */
export type FolderTarget = string | null | undefined | { projectId?: string | null; workspaceId?: string | null; folder?: string | null };

export const DEFAULT_FILE_LIMIT = 50;
const MAX_FILE_LIMIT = 200;

export class FolderInfoService {
  private readonly commands = new Map<string, CacheEntry<SlashCommand[]>>();
  private readonly files = new Map<string, CacheEntry<FolderFiles>>();
  private readonly modes = new Map<string, CacheEntry<FolderPermissionModes>>();

  constructor(private readonly options: FolderInfoOptions) {}

  /**
   * The folder for `target` (see the header for the order). `null` = a group project without a
   * chat or folder: nothing to list. 404 for unknown chats/projects, 400 for bad folders.
   */
  async folderFor(target: FolderTarget): Promise<string | null> {
    const { projectId, workspaceId, folder } = typeof target === "object" && target !== null ? target : { projectId: target };
    if (workspaceId) {
      const cwd = this.options.workspaceCwd?.(workspaceId);
      if (!cwd) throw new HttpError(404, "Chat not found");
      return cwd;
    }
    if (folder) {
      if (!this.options.resolveFolder) throw new HttpError(400, "Folders can't be asked about here");
      return this.options.resolveFolder(folder);
    }
    if (!projectId) return this.options.scratchDir;
    const path = this.options.projectPath(projectId);
    if (path === undefined) throw new HttpError(404, "Project not found");
    return path;
  }

  /** The harness `harnessId` (default: the default one); 400 when it isn't offered here. */
  harnessFor(harnessId?: string | null): AgentHarness {
    const harness = this.options.harness(harnessId || undefined);
    if (!harness) throw new HttpError(400, `The agent "${harnessId}" isn't available on this device`);
    return harness;
  }

  /** Harness commands (extensions, skills, prompts) available in the folder, of `harnessId` (default: the default agent). */
  async listCommands(target: FolderTarget, force = false, harnessId?: string | null): Promise<SlashCommand[]> {
    const cwd = await this.folderFor(target);
    const harness = this.harnessFor(harnessId);
    if (!harness.listFolderCommands || cwd === null) return [];
    const key = `${harness.id}\0${cwd}`;
    return this.cached(this.commands, key, this.options.commandsTtlMs ?? 60_000, force, () => harness.listFolderCommands!(cwd));
  }

  /**
   * The modes a new chat of `harnessId` (default: the default agent) in the folder can start in,
   * and its default (I-184). No modes for harnesses without the `permissionModes` capability.
   */
  async getPermissionModes(target: FolderTarget, harnessId?: string | null, model: ModelRef | null = null, force = false): Promise<FolderPermissionModes> {
    // A group without a folder yet: the agent's defaults, as in the scratch folder (I-213).
    const cwd = (await this.folderFor(target)) ?? this.options.scratchDir;
    const harness = this.harnessFor(harnessId);
    if (!harness.info.capabilities.permissionModes || !harness.getPermissionModes) return { modes: [], defaultMode: null };
    const key = `${harness.id}\0${cwd}\0${model ? `${model.provider}/${model.id}` : ""}`;
    return this.cached(this.modes, key, this.options.modesTtlMs ?? 60_000, force, () => harness.getPermissionModes!(cwd, model));
  }

  /** Files/folders of the folder matching `query`, best first. */
  async searchFiles(target: FolderTarget, query: string, limit = DEFAULT_FILE_LIMIT): Promise<FileSearchResponse> {
    const cwd = await this.folderFor(target);
    if (cwd === null) return { entries: [], truncated: false };
    const list = this.options.listFiles ?? listFolderFiles;
    const { entries, truncated } = await this.cached(this.files, cwd, this.options.filesTtlMs ?? 10_000, false, () => list(cwd));
    const cap = Math.max(1, Math.min(MAX_FILE_LIMIT, Math.floor(limit) || DEFAULT_FILE_LIMIT));
    return { entries: rankFiles(entries, query, cap), truncated };
  }

  /**
   * The harness's own default model/thinking level (`null`s when it can't tell), of `harnessId`
   * (I-198; 404 when this device doesn't offer it), else of the default agent.
   */
  async getDefaults(force = false, harnessId?: string | null): Promise<HarnessDefaults> {
    const harness = harnessId ? this.options.harness(harnessId) : this.harnessFor();
    if (!harness) throw new HttpError(404, `The agent "${harnessId}" isn't available on this device`);
    return (await harness.getDefaults?.(force)) ?? { model: null, thinkingLevel: null };
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
