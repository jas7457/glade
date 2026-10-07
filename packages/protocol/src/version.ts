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
 * Update Now (I-154): the desktop app's server runs the update for you (pull, install, rebuild)
 * as a background job, local owner only:
 *
 *   GET  /api/version/update         → UpdateJobStatus (also pushed as `update` on the local socket)
 *   POST /api/version/update         → UpdateJobStatus (starts it; 409 with `error` when it can't)
 *   POST /api/version/update/cancel  → UpdateJobStatus (before the install step only)
 *
 * The Mac shell then relaunches the new bundle (the `relaunch` command, packages/app-core/src/lib/desktop.ts).
 *
 * I-197: the restart is automatic. The desktop server notices when a newer build has been put in
 * place of its app bundle (Update Now, or `pnpm tauri:install` run from a terminal or a chat) and
 * reports it as `VersionStatus.installed` (pushed as `version` on the local socket). The Mac app's
 * own window then restarts right away when no chat of this server is working, else as soon as
 * they all finish (cancelable). Never in `pnpm dev`, browsers or other devices.
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

/** The command the About page offers to copy (`pnpm dev`; the Mac app has Update Now, I-154). */
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
  /**
   * I-197: a different build now sits in this server's app bundle (installed after this server
   * started), so restarting the app runs it. Absent/null when nothing new was installed, and
   * always for `dev` servers.
   */
  installed?: BuildInfo | null;
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

// --- Update Now (I-154) ----------------------------------------------------------------------

export type UpdateStepId = "pull" | "install" | "build";

/** The update job's steps, in order, run in the repo folder through the user's login shell. */
export const UPDATE_STEPS: ReadonlyArray<{ id: UpdateStepId; label: string; command: string }> = [
  { id: "pull", label: "Pull main", command: "git pull --ff-only" },
  { id: "install", label: "Install dependencies", command: "pnpm install --frozen-lockfile" },
  { id: "build", label: "Build and install Glade", command: "pnpm tauri:install" },
];

export type UpdateStepState = "pending" | "running" | "done" | "failed" | "cancelled";

export interface UpdateStep {
  id: UpdateStepId;
  label: string;
  command: string;
  state: UpdateStepState;
}

/**
 * - `idle`: nothing started since this server started.
 * - `checking`: the guards run (repo folder, clean, on main, fast-forward possible).
 * - `running`: a step runs (see `steps`).
 * - `refused`: a guard said no (`error` says why); nothing was changed.
 * - `failed`: a step failed (`error`; the log tail says more).
 * - `cancelled`: stopped by Cancel.
 * - `installed`: the new version is in place; Glade restarts into it (I-197: automatically).
 */
export type UpdateJobState = "idle" | "checking" | "running" | "refused" | "failed" | "cancelled" | "installed";

export interface UpdateJobStatus {
  /** This server can update the app (the Mac app's server only; `pnpm dev` shows the command). */
  available: boolean;
  /** Why not, when `available` is false. */
  unavailableReason?: string;
  state: UpdateJobState;
  steps: UpdateStep[];
  /** Why it was refused / failed, in a sentence. */
  error?: string;
  /** The last lines of the commands' output (a ring buffer). */
  log: string[];
  /** Cancel is possible now (checking, or before the install step). */
  canCancel: boolean;
  /** ISO times of the last job. */
  startedAt?: string;
  endedAt?: string;
}
