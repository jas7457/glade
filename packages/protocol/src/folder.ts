/**
 * Folder-level info that doesn't need a running chat (I-043, I-044, I-050): the harness's slash
 * commands for a folder, file listings for `@` mentions, and the harness's own default model.
 *
 *   GET /api/commands?projectId=[&refresh=1]      → SlashCommand[]
 *   GET /api/files?projectId=&q=[&limit=]         → FileSearchResponse
 *   GET /api/models/default[?refresh=1]           → HarnessDefaults
 *
 * `projectId` omitted/empty = the scratch folder of standalone chats.
 */
import type { ModelRef, ThinkingLevel } from "./models.js";

/** What the harness uses when no model/thinking level is given (pi: `~/.pi/agent/settings.json`). */
export interface HarnessDefaults {
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
}

export interface FileEntry {
  /** Relative to the folder, `/`-separated, no trailing slash. */
  path: string;
  kind: "file" | "dir";
}

export interface FileSearchResponse {
  /** Best matches first (capped by `limit`). */
  entries: FileEntry[];
  /** The folder has more files than Glade indexes; some may be missing. */
  truncated: boolean;
}
