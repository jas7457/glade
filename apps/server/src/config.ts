import { realpathSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, relative, isAbsolute, resolve } from "node:path";

export const VERSION = "0.1.0";

/**
 * Where pi-ui keeps its own data (settings, projects, chat index, scratch folder).
 * Session transcripts themselves are owned by the harness (pi stores them in ~/.pi/agent/sessions).
 */
export function defaultDataDir(): string {
  return process.env.PI_UI_DATA_DIR || platformDataDir();
}

/** The per-platform data folder, ignoring `PI_UI_DATA_DIR`. */
export function platformDataDir(): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "pi-ui");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "pi-ui");
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "pi-ui");
}

export interface ServerConfig {
  dataDir: string;
  /** Working directory for chats that don't belong to a project. */
  scratchDir: string;
  host: string;
  port: number;
  /** Which harness to use for new chats. */
  harness: "pi" | "fake";
  /** Built web app to serve (`PI_UI_STATIC_DIR`); defaults to `apps/web/dist` in the repo. */
  staticDir?: string;
  /** Exit when stdin closes (`PI_UI_EXIT_ON_STDIN_CLOSE=1`): the desktop app's lifeline. */
  exitOnStdinClose: boolean;
}

export function loadConfig(): ServerConfig {
  const dataDir = defaultDataDir();
  return {
    dataDir,
    scratchDir: join(dataDir, "scratch"),
    // Loopback only by default. Remote access will need auth before this is opened up.
    host: process.env.PI_UI_HOST ?? "127.0.0.1",
    port: Number(process.env.PI_UI_PORT ?? 4317),
    harness: process.env.PI_UI_HARNESS === "fake" ? "fake" : "pi",
    staticDir: process.env.PI_UI_STATIC_DIR || undefined,
    exitOnStdinClose: process.env.PI_UI_EXIT_ON_STDIN_CLOSE === "1",
  };
}

/** Resolves symlinks where possible (macOS: /tmp → /private/tmp), else just normalises. */
function realish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when `dir` lies inside a temporary folder (`os.tmpdir()`, /tmp, /var/tmp), where data can
 * vanish on reboot or cleanup (I-051). Sandboxes from `pnpm dev:agent` live there on purpose.
 */
export function isTemporaryDir(dir: string, tempRoots: string[] = [tmpdir(), "/tmp", "/var/tmp"]): boolean {
  const candidates = new Set([resolve(dir), realish(dir)]);
  for (const root of tempRoots) {
    for (const r of new Set([resolve(root), realish(root)])) {
      for (const c of candidates) {
        const rel = relative(r, c);
        if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
      }
    }
  }
  return false;
}

/**
 * The startup banner: where the data lives, where to open the app, which harness runs. Plus a
 * warning when the data folder is temporary (unless this is a `pnpm dev:agent` sandbox).
 */
export function startupBanner(opts: {
  url: string;
  dataDir: string;
  harness: string;
  kind: string;
  sandbox?: string;
  temporary: boolean;
}): string[] {
  const title = opts.sandbox ? `pi-ui sandbox "${opts.sandbox}" (agent testing only)` : `pi-ui ${opts.kind} server`;
  const lines = [
    `┌─ ${title}`,
    `│  URL:      ${opts.url}`,
    `│  Data:     ${opts.dataDir}`,
    `│  Harness:  ${opts.harness}`,
    `└─`,
  ];
  if (opts.temporary && !opts.sandbox) {
    lines.push(
      `⚠  The data folder is in a temporary directory (PI_UI_DATA_DIR=${opts.dataDir}).`,
      `⚠  Chats saved here are separate from your real ones and can be deleted by the system.`,
      `⚠  Unset PI_UI_DATA_DIR to use the normal folder (${platformDataDir()}).`,
    );
  }
  return lines;
}
