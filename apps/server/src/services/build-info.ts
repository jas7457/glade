/**
 * Which commit this server was built from (I-149).
 *
 * - The desktop app's bundled server (`apps/desktop/scripts/bundle-server.mjs`) gets the stamp at
 *   build time: esbuild replaces `__GLADE_BUILD__` with {@link gitStamp}'s result for the repo it
 *   was built from.
 * - `pnpm dev` (tsx) has no build step: {@link currentBuild} reads the live git info of this
 *   checkout (cached for a short while, so a commit or a pull shows up without a restart).
 *
 * Self-contained (node built-ins and types only): the bundle script compiles this file on its own
 * to call {@link gitStamp}.
 */
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildInfo } from "@glade/protocol";

/** Runs `git <args>` in `cwd` and returns stdout (throws on failure). */
export type GitRunSync = (args: string[], cwd: string) => string;

export const runGitSync: GitRunSync = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });

/**
 * The stamp for the checkout containing `dir`: HEAD, whether it has local changes, and its root.
 * `builtAt` is `now` for a release build; a dev server uses its HEAD commit's time. Null when
 * `dir` isn't in a git checkout (or git isn't installed).
 */
export function gitStamp(dir: string, kind: BuildInfo["kind"], git: GitRunSync = runGitSync, now: () => Date = () => new Date()): BuildInfo | null {
  try {
    const commit = git(["rev-parse", "HEAD"], dir).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) return null;
    const repoPath = git(["rev-parse", "--show-toplevel"], dir).trim() || null;
    let dirty = false;
    try {
      dirty = git(["status", "--porcelain", "--untracked-files=no"], dir).trim().length > 0;
    } catch {
      // unknown: say clean
    }
    let builtAt = now().toISOString();
    if (kind === "dev") {
      try {
        builtAt = new Date(git(["log", "-1", "--format=%cI", commit], dir).trim()).toISOString();
      } catch {
        // keep now
      }
    }
    return { commit, shortCommit: commit.slice(0, 7), builtAt, dirty, repoPath, kind };
  } catch {
    return null;
  }
}

/** Replaced by the bundle script (esbuild `define`); a bare identifier under tsx. */
declare const __GLADE_BUILD__: BuildInfo | null | undefined;

/** The stamp compiled into this bundle, or undefined when running from source. */
function stampedBuild(): BuildInfo | null | undefined {
  return typeof __GLADE_BUILD__ === "undefined" ? undefined : __GLADE_BUILD__;
}

const DEV_TTL_MS = 30_000;
let devCache: { at: number; build: BuildInfo | null } | null = null;

/** This server's build: the compiled-in stamp, else live git info of this source checkout. */
export function currentBuild(): BuildInfo | null {
  const stamped = stampedBuild();
  if (stamped !== undefined) return stamped;
  const now = Date.now();
  if (!devCache || now - devCache.at > DEV_TTL_MS) {
    devCache = { at: now, build: gitStamp(dirname(fileURLToPath(import.meta.url)), "dev") };
  }
  return devCache.build;
}
