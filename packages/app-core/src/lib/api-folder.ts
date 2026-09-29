/**
 * REST client for folder-level info that doesn't need a chat (I-043, I-044, I-050).
 * `projectId: null` = the scratch folder of standalone chats. See docs/ARCHITECTURE.md.
 * `via`: the environment to ask (I-123; default the local one, see `state/env-api.ts`).
 */
import type { FileSearchResponse, HarnessDefaults, SlashCommand } from "@glade/protocol";
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

/** The harness's slash commands (extensions, skills, prompts) for a project/scratch folder. */
export function listFolderCommands(projectId: string | null, refresh = false, via: RequestFn = request): Promise<SlashCommand[]> {
  return via<SlashCommand[]>("GET", `/commands${query({ projectId, refresh })}`);
}

/** Files/folders of a project/scratch folder matching `q`, best first (for `@` mentions). */
export function searchFiles(projectId: string | null, q: string, limit?: number, via: RequestFn = request): Promise<FileSearchResponse> {
  return via<FileSearchResponse>("GET", `/files${query({ projectId, q, limit })}`);
}

/** The harness's own default model + thinking level (what "Default" means). */
export function getHarnessDefaults(refresh = false, via: RequestFn = request): Promise<HarnessDefaults> {
  return via<HarnessDefaults>("GET", `/models/default${query({ refresh })}`);
}
