/**
 * The built web app, read into memory once at startup (I-082). The desktop app's server serves
 * the web app from inside `/Applications/Glade.app`; `pnpm tauri:install` swaps that bundle while
 * the old app keeps running, so a running server must keep serving the files it started with
 * (new web code talking to an old server could break). ~11 MB for the whole app.
 *
 *   const snapshot = loadStaticSnapshot(staticDir); // null if there's no index.html
 *   snapshot?.get("/assets/index-abc.js") // { body, type } | undefined
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

export interface StaticFile {
  body: Buffer;
  type: string;
}

export interface StaticSnapshot {
  /** A file by URL path (`/assets/x.js`), or undefined. */
  get(path: string): StaticFile | undefined;
  /** `index.html`, for the SPA fallback. */
  index: StaticFile;
  size: number;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".icns": "image/icns",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

export function contentType(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function loadStaticSnapshot(dir: string): StaticSnapshot | null {
  const files = new Map<string, StaticFile>();
  let size = 0;
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() || statSync(full).isFile()) {
        const body = readFileSync(full);
        size += body.length;
        files.set("/" + relative(dir, full).split(sep).join("/"), { body, type: contentType(full) });
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  const index = files.get("/index.html");
  if (!index) return null;
  return {
    get: (path) => {
      let decoded = path;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        /* keep as is */
      }
      return files.get(decoded);
    },
    index,
    size,
  };
}
