/**
 * REST client for folder-level info that doesn't need a chat (I-043, I-044, I-050).
 * `projectId: null` = the scratch folder of standalone chats. See docs/ARCHITECTURE.md.
 * `via`: the environment to ask (I-123; default the local one, see `state/env-api.ts`).
 */
import type { FileSearchResponse, FolderPermissionModes, HarnessDefaults, ModelRef, SlashCommand } from "@glade/protocol";
import { request, type RequestFn } from "./api";

const query = (params: Record<string, string | number | boolean | null | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === false || value === "") continue;
    search.set(key, value === true ? "1" : String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : "";
};

/**
 * The harness's slash commands (extensions, skills, prompts) for a project/scratch folder, of
 * `harness` (the agent picked for a new chat, I-185; omitted: the default agent).
 */
export function listFolderCommands(projectId: string | null, refresh = false, via: RequestFn = request, harness?: string | null): Promise<SlashCommand[]> {
  return via<SlashCommand[]>("GET", `/commands${query({ projectId, harness, refresh })}`);
}

/** The modes a new chat of `harness` (omitted: the default agent) on `model` can start in, and its default (I-184). */
export function getFolderPermissionModes(
  projectId: string | null,
  harness: string | null,
  model: ModelRef | null,
  via: RequestFn = request,
): Promise<FolderPermissionModes> {
  return via<FolderPermissionModes>("GET", `/permission-modes${query({ projectId, harness, provider: model?.provider, model: model?.id })}`);
}

/** Files/folders of a project/scratch folder matching `q`, best first (for `@` mentions). */
export function searchFiles(projectId: string | null, q: string, limit?: number, via: RequestFn = request): Promise<FileSearchResponse> {
  return via<FileSearchResponse>("GET", `/files${query({ projectId, q, limit })}`);
}

/**
 * The harness's own default model + thinking level (what "Default" means): of `harness` (I-198),
 * else the default agent's.
 */
export function getHarnessDefaults(refresh = false, via: RequestFn = request, harness?: string | null): Promise<HarnessDefaults> {
  return via<HarnessDefaults>("GET", `/models/default${query({ refresh, harness })}`);
}
