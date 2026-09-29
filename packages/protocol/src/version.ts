/**
 * Build stamp and "is this app behind?" (I-149).
 *
 * Glade is built locally from a git checkout (`pnpm tauri:install`), so the app knows which commit
 * it was built from and can compare it with the repo's `origin/main` (a read-only
 * `git ls-remote`, never a fetch), and with the builds of the other devices it connects to.
 *
 *   GET  /api/environment               → EnvironmentInfo, with `build` (additive, optional)
 *   GET  /api/version                   → VersionStatus
 *   POST /api/version/check             → VersionStatus (checks now, answers when done)
 *   GET  /api/version/compare?commit=…  → BuildComparison (another build's commit vs. ours)
 *
 * There is no Update button (F-024): the About page shows the command to run.
 */

/** Which commit a server was built from. */
export interface BuildInfo {
  /** Full commit sha (HEAD at build time). */
  commit: string;
  /** Short sha, e.g. "1f00e8a". */
  shortCommit: string;
  /**
   * ISO time of the build (`pnpm tauri:install`). A `dev` server has no build step: its HEAD
   * commit's time.
   */
  builtAt: string;
  /** The checkout had uncommitted changes ("local changes"). */
  dirty: boolean;
  /** The repo folder it was built from (the behind check only runs when it exists on this machine). */
  repoPath: string | null;
  /** `release`: the installed app's bundled server (stamped at build time). `dev`: `pnpm dev` (live git info). */
  kind: "release" | "dev";
}

/** The branch the behind check compares with. */
export const UPDATE_BRANCH = "main";

/** The command the About page offers to copy (F-024 will run it for you). */
export const UPDATE_COMMAND = "git pull && pnpm install && pnpm tauri:install";

/**
 * - `up-to-date`: the build is origin's main.
 * - `behind`: origin's main has `behind` commits the build doesn't (counted in the local repo).
 * - `update-available`: origin's main is a commit the local repo doesn't have yet (not fetched),
 *   so it can't be counted.
 * - `failed`: `git ls-remote` failed (offline, no credentials, timeout…): "Couldn't check".
 * - `unavailable`: nothing to check against (no build stamp, or its repo folder isn't on this machine).
 */
export type UpdateCheckState = "up-to-date" | "behind" | "update-available" | "failed" | "unavailable";

export interface UpdateCheck {
  state: UpdateCheckState;
  /** Commits behind (`behind` only). */
  behind?: number;
  /** origin's main when it could be read. */
  remoteCommit?: string;
  /** Why (`failed` / `unavailable`), in a sentence. */
  reason?: string;
  /** ISO time the check finished. */
  checkedAt: string;
}

export interface VersionStatus {
  /** This server's build; null when unknown (no stamp and no git). */
  build: BuildInfo | null;
  /** The last check; null before the first one finished. */
  check: UpdateCheck | null;
  /** A check is running. */
  checking: boolean;
}

/**
 * Another build's commit compared with this server's (Connections, I-149).
 * `count` is set when the local repo has both commits:
 * - `older`: it's `count` commits behind this build;
 * - `newer`: it's `count` commits ahead;
 * - `diverged`: neither contains the other (`count` unset);
 * - `same`: the same commit;
 * - `unknown`: the local repo can't tell (missing commit, no repo): compare build times instead.
 */
export interface BuildComparison {
  commit: string;
  relation: "same" | "older" | "newer" | "diverged" | "unknown";
  count?: number;
}
