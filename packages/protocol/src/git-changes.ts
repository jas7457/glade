/**
 * Changes panel (I-097): what git sees in a workspace's folder, whoever changed it.
 *
 *   GET  /api/workspaces/:id/changes                  → GitChangesResponse
 *   GET  /api/workspaces/:id/changes/diff?path=       → GitFileDiffResponse
 *   POST /api/workspaces/:id/changes/revert           → GitChangesResponse   (RevertChangesRequest)
 *   POST /api/workspaces/:id/changes/commit           → CommitChangesResponse (CommitChangesRequest)
 *   POST /api/workspaces/:id/changes/commit-message   → CommitMessageResponse (CommitMessageRequest)
 *
 * Paths are relative to the repository root, with `/` separators (what git prints).
 */
import type { DiffLine } from "./transcript.js";

/** How a file differs from `HEAD` (staged and unstaged changes together). */
export type GitChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface GitChangedFile {
  /** Path relative to the repository root. */
  path: string;
  /** The old path of a rename. */
  oldPath?: string;
  kind: GitChangeKind;
  /** Lines added / removed compared with `HEAD`; `null` when unknown (binary, too large). */
  added: number | null;
  removed: number | null;
  binary: boolean;
}

export type GitChangesResponse =
  | { isRepo: false }
  | {
      isRepo: true;
      /** Current branch; `null` when detached. */
      branch: string | null;
      /** Short hash of `HEAD` (shown instead of the branch when detached; I-107); absent before the first commit. */
      head?: string;
      /** Absolute path of the repository's work tree. */
      root: string;
      /** The workspace folder relative to `root` (`""` at the root, else ending in `/`). */
      prefix: string;
      files: GitChangedFile[];
      /** More files changed than are listed. */
      truncated: boolean;
    };

export interface GitFileDiffResponse {
  path: string;
  binary: boolean;
  lines: DiffLine[];
  /** The diff was cut short (too many lines). */
  truncated: boolean;
}

export interface RevertChangesRequest {
  paths: string[];
}

export interface CommitChangesRequest {
  message: string;
  /** Files to commit; omitted = every changed file. */
  paths?: string[];
}

export interface CommitChangesResponse {
  /** Abbreviated hash of the new commit. */
  commit: string;
  /** First line of the message. */
  summary: string;
}

export interface CommitMessageRequest {
  /** Files the message is for; omitted = every changed file. */
  paths?: string[];
}

export interface CommitMessageResponse {
  message: string;
}
