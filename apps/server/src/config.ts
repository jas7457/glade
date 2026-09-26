import { homedir, platform } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";

/**
 * Where pi-ui keeps its own data (settings, projects, chat index, scratch folder).
 * Session transcripts themselves are owned by the harness (pi stores them in ~/.pi/agent/sessions).
 */
export function defaultDataDir(): string {
  if (process.env.PI_UI_DATA_DIR) return process.env.PI_UI_DATA_DIR;
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
  };
}
