/**
 * Folder-level info that doesn't need a running chat (I-043, I-044, I-050): the harness's slash
 * commands for a folder, file listings for `@` mentions, and the harness's own default model.
 *
 *   GET /api/commands?projectId=[&harness=][&refresh=1]                 → SlashCommand[]
 *   GET /api/files?projectId=&q=[&limit=]                               → FileSearchResponse
 *   GET /api/models/default[?refresh=1]                                 → HarnessDefaults
 *   GET /api/permission-modes?projectId=[&harness=][&provider=&model=]  → FolderPermissionModes
 *
 * `projectId` omitted/empty = the scratch folder of standalone chats. `harness` (a
 * `HarnessInfo.id`, I-185): the agent picked in the new-chat composer; omitted = the default one.
 * 400 when that agent isn't offered on this device.
 */
import type { PermissionModeInfo } from "./events.js";
import type { ModelRef, ThinkingLevel } from "./models.js";

/** What the harness uses when no model/thinking level is given (pi: `~/.pi/agent/settings.json`). */
/** `GET /api/models/default[?refresh=1][&harness=<id>]` (I-198: `harness` = that agent's own default; else the default agent's). */
export interface HarnessDefaults {
  model: ModelRef | null;
  thinkingLevel: ThinkingLevel | null;
}

/**
 * The permission modes a new chat of a harness can start in, for a folder (I-184): what the
 * new-chat composer's mode pill offers before the chat exists. `model` (optional) narrows the list
 * to that model's modes (Claude Code's Auto needs a model that supports it).
 */
export interface FolderPermissionModes {
  /** In Shift+Tab order. Empty: the harness has no modes (the pill is hidden). */
  modes: PermissionModeInfo[];
  /** The mode a new chat starts in unless another is picked (the agent's own default); one of `modes`' ids. */
  defaultMode: string | null;
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
