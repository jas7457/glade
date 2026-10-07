/**
 * "A newer Glade was installed into this app" (I-197): watches the build stamp in this server's
 * own app bundle.
 *
 * The bundle script writes the stamp as `app/build.json` next to `server.mjs`. `pnpm tauri:install`
 * (run by Update Now or from a terminal/chat) swaps a new bundle into the same path with renames
 * (I-082), so the path of the running server file now leads into the new bundle and its
 * `build.json` holds the new build's stamp. When that stamp's commit or build time differs from
 * the running one, {@link InstalledBuildWatcher.installed} reports it (`VersionStatus.installed`),
 * and the Mac app's window restarts into it.
 *
 * Release builds only (`currentBuild().kind === "release"`); `pnpm dev` never watches. Polls with a
 * cheap `stat` every few seconds and reads the file only when its size/mtime changed. A missing or
 * unreadable file (e.g. the moment between the two renames) keeps the last answer.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildInfo } from "@glade/protocol";

export const POLL_MS = 3000;
export const STAMP_FILE = "build.json";

/** The stamp file next to the running server file (in the bundle: `<app>/Contents/Resources/app/build.json`). */
export function defaultStampPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), STAMP_FILE);
}

export interface StampFs {
  /** A change token for the file (size + mtime), or null when it can't be read. */
  stat(path: string): string | null;
  read(path: string): string;
}

const nodeFs: StampFs = {
  stat(path) {
    try {
      const s = statSync(path);
      return `${s.size}:${s.mtimeMs}:${s.ino}`;
    } catch {
      return null;
    }
  },
  read: (path) => readFileSync(path, "utf8"),
};

export interface InstalledBuildOptions {
  /** The running build. The watcher only runs for `release` builds. */
  running: BuildInfo | null;
  /** Default: {@link defaultStampPath}. */
  path?: string;
  fs?: StampFs;
  intervalMs?: number;
  /** Called when {@link InstalledBuildWatcher.installed} changes. */
  onChange?: (installed: BuildInfo | null) => void;
  log?: (msg: string) => void;
}

function isBuild(value: unknown): value is BuildInfo {
  const v = value as Partial<BuildInfo> | null;
  return !!v && typeof v === "object" && typeof v.commit === "string" && typeof v.builtAt === "string" && typeof v.shortCommit === "string";
}

export function sameBuild(a: BuildInfo, b: BuildInfo): boolean {
  return a.commit === b.commit && a.builtAt === b.builtAt;
}

export class InstalledBuildWatcher {
  private readonly path: string;
  private readonly fs: StampFs;
  private token: string | null = null;
  private current: BuildInfo | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: InstalledBuildOptions) {
    this.path = options.path ?? defaultStampPath();
    this.fs = options.fs ?? nodeFs;
  }

  /** Watches only for a release build. */
  get enabled(): boolean {
    return this.options.running?.kind === "release";
  }

  /** The different build now in the bundle, else null. */
  installed(): BuildInfo | null {
    return this.current;
  }

  /** Polls every interval (the timer doesn't keep the process alive). */
  start(): void {
    if (!this.enabled || this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.options.intervalMs ?? POLL_MS);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Looks at the stamp file now (also right after Update Now's install step). */
  poll(): BuildInfo | null {
    const running = this.options.running;
    if (!running || !this.enabled) return null;
    const token = this.fs.stat(this.path);
    if (token === null || token === this.token) return this.current;
    let stamp: unknown;
    try {
      stamp = JSON.parse(this.fs.read(this.path));
    } catch {
      // half-written or gone again: try next time
      return this.current;
    }
    this.token = token;
    const next = isBuild(stamp) && !sameBuild(stamp, running) ? stamp : null;
    const changed = next === null ? this.current !== null : this.current === null || !sameBuild(next, this.current);
    this.current = next;
    if (changed) {
      if (next) this.options.log?.(`a newer build was installed: ${next.shortCommit} (${next.builtAt})`);
      this.options.onChange?.(next);
    }
    return next;
  }
}
