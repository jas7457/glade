/**
 * The folder browser's memory (I-213): per device (localStorage) and per key (callers pass the
 * environment id), the last folder a `FolderBrowser` was in, so it reopens there. A remembered
 * folder that no longer loads (deleted, moved, unmounted volume) falls back to its nearest parent
 * that does, else home, without showing an error.
 */
import { readStored, writeStored } from "@glade/app-core/state/ui";

const KEY_PREFIX = "glade.folderBrowser.lastFolder.";

/** The last folder remembered for `key`, or null. */
export function rememberedFolder(key: string): string | null {
  const value = readStored(KEY_PREFIX + key);
  return value && value.startsWith("/") ? value : null;
}

/** Remember `path` (absolute) as the last folder for `key`. */
export function rememberFolder(key: string, path: string): void {
  if (path.startsWith("/")) writeStored(KEY_PREFIX + key, path);
}

/** `path` and each of its parents, deepest first, ending at `/`: `/a/b` → `/a/b`, `/a`, `/`. */
export function selfAndParents(path: string): string[] {
  const out: string[] = [];
  let current = path.replace(/\/+$/, "") || "/";
  for (;;) {
    out.push(current);
    if (current === "/") return out;
    const slash = current.lastIndexOf("/");
    current = slash <= 0 ? "/" : current.slice(0, slash);
  }
}

/** What trying one folder gave: it loaded, it didn't, or a newer navigation took over (stop). */
export type OpenAttempt = "ok" | "failed" | "stale";

/**
 * Open the remembered `path`, else its nearest parent that opens, else home (`~`). Resolves the
 * folder that opened, or null when nothing did (or another navigation took over).
 */
export async function openNearest(path: string, tryOpen: (path: string) => Promise<OpenAttempt>): Promise<string | null> {
  for (const candidate of [...selfAndParents(path), "~"]) {
    const result = await tryOpen(candidate);
    if (result === "ok") return candidate;
    if (result === "stale") return null;
  }
  return null;
}
