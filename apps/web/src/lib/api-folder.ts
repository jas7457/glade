/**
 * REST client for folder-level info that doesn't need a chat (I-043, I-044, I-050).
 * `projectId: null` = the scratch folder of standalone chats. See docs/ARCHITECTURE.md.
 */
import type { FileSearchResponse, HarnessDefaults, SlashCommand } from "@pi-ui/protocol";
import { request } from "./api";

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
export function listFolderCommands(projectId: string | null, refresh = false): Promise<SlashCommand[]> {
  return request<SlashCommand[]>("GET", `/commands${query({ projectId, refresh })}`);
}

/** Files/folders of a project/scratch folder matching `q`, best first (for `@` mentions). */
export function searchFiles(projectId: string | null, q: string, limit?: number): Promise<FileSearchResponse> {
  return request<FileSearchResponse>("GET", `/files${query({ projectId, q, limit })}`);
}

/** The harness's own default model + thinking level (what "Default" means). */
export function getHarnessDefaults(refresh = false): Promise<HarnessDefaults> {
  return request<HarnessDefaults>("GET", `/models/default${query({ refresh })}`);
}
