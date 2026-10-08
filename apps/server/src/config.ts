import { realpathSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, relative, isAbsolute, resolve } from "node:path";

export const VERSION = "0.1.0";

/** Prefix of our environment variables (`GLADE_DATA_DIR`, `GLADE_PORT`, …). */
export const ENV_PREFIX = "GLADE_";
/** The prefix used before the rename to Glade (I-059); still accepted as a fallback. */
export const LEGACY_ENV_PREFIX = "PI_UI_";

/**
 * Reads one of our environment variables by its short name (`env("PORT")`): `GLADE_PORT`, else
 * the pre-rename `PI_UI_PORT`. Empty values count as unset.
 */
export function env(name: string, source: NodeJS.ProcessEnv = process.env): string | undefined {
  return source[ENV_PREFIX + name] || source[LEGACY_ENV_PREFIX + name] || undefined;
}

/** The app's name, used for the data folder. */
export const APP_NAME = "Glade";
/** The data folder's name before the rename (I-059); copied once into the new one. */
export const LEGACY_APP_DIR_NAME = "pi-ui";

/**
 * Where Glade keeps its own data (settings, projects, chat index, scratch folder).
 * Session transcripts themselves are owned by the harness (pi stores them in ~/.pi/agent/sessions).
 */
export function defaultDataDir(): string {
  return env("DATA_DIR") || platformDataDir();
}

/** The per-platform data folder, ignoring `GLADE_DATA_DIR`. `name` = the folder's name. */
export function platformDataDir(name: string = APP_NAME): string {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", name);
  if (platform() === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), name);
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), name);
}

export interface ServerConfig {
  dataDir: string;
  /** Working directory for chats that don't belong to a project. */
  scratchDir: string;
  host: string;
  port: number;
  /** Which harness to use for new chats (`demo`: the website demo's pi/Claude Code/Codex stand-ins, I-209). */
  harness: HarnessMode;
  /** Built web app to serve (`GLADE_STATIC_DIR`); defaults to `apps/web/dist` in the repo. */
  staticDir?: string;
  /** Exit when stdin closes (`GLADE_EXIT_ON_STDIN_CLOSE=1`): the desktop app's lifeline. */
  exitOnStdinClose: boolean;
  /** True when the data folder is the platform default (no `GLADE_DATA_DIR`): the one migrated from pi-ui. */
  defaultDataDir: boolean;
}

export function loadConfig(): ServerConfig {
  const dataDir = defaultDataDir();
  return {
    dataDir,
    scratchDir: join(dataDir, "scratch"),
    // Loopback only by default. Remote access will need auth before this is opened up.
    host: env("HOST") ?? "127.0.0.1",
    port: Number(env("PORT") ?? 4317),
    harness: harnessMode(),
    staticDir: env("STATIC_DIR"),
    exitOnStdinClose: env("EXIT_ON_STDIN_CLOSE") === "1",
    defaultDataDir: !env("DATA_DIR"),
  };
}

export type HarnessMode = "pi" | "fake" | "demo";

/**
 * `GLADE_HARNESS`: `fake` for UI work, `demo` for the website demo (I-209), else the real agents.
 * Demo mode replaces pi, Claude Code and Codex with scripted stand-ins, so it only turns on in a
 * `pnpm dev:agent` sandbox (`GLADE_SANDBOX` set) with its own data folder in a temporary
 * location; anywhere else the real agents run and a warning is printed.
 */
export function harnessMode(source: NodeJS.ProcessEnv = process.env, warn: (msg: string) => void = console.warn): HarnessMode {
  const value = env("HARNESS", source);
  if (value === "fake") return "fake";
  if (value !== "demo") return "pi";
  const dataDir = env("DATA_DIR", source);
  if (env("SANDBOX", source) && dataDir && isTemporaryDir(dataDir)) return "demo";
  warn("[glade] GLADE_HARNESS=demo only works in a demo sandbox (pnpm dev:agent --demo); running the real agents");
  return "pi";
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
  const title = opts.sandbox ? `Glade sandbox "${opts.sandbox}" (agent testing only)` : `Glade ${opts.kind} server`;
  const lines = [
    `┌─ ${title}`,
    `│  URL:      ${opts.url}`,
    `│  Data:     ${opts.dataDir}`,
    `│  Harness:  ${opts.harness}`,
    `└─`,
  ];
  if (opts.temporary && !opts.sandbox) {
    lines.push(
      `⚠  The data folder is in a temporary directory (GLADE_DATA_DIR=${opts.dataDir}).`,
      `⚠  Chats saved here are separate from your real ones and can be deleted by the system.`,
      `⚠  Unset GLADE_DATA_DIR to use the normal folder (${platformDataDir()}).`,
    );
  }
  return lines;
}
