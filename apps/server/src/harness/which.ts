/**
 * Is an agent installed? (I-155) A PATH lookup, like `which`: a bare command is searched in the
 * PATH's folders, a path (with a `/`) is checked directly. Nothing is started. Results are cached
 * for a few seconds because the harness registry asks on every lookup.
 *
 *   findExecutable("pi")            // "/opt/homebrew/bin/pi" | null
 *   const which = cachedWhich();    // (command) => boolean, 5 s cache
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

/** `(command) => installed?`; injectable in tests. */
export type WhichFn = (command: string) => boolean;

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Full path of `command`, or null when it can't be found. */
export function findExecutable(command: string, pathEnv = process.env.PATH ?? ""): string | null {
  const cmd = command.trim().replace(/^~(?=\/)/, homedir());
  if (!cmd) return null;
  if (cmd.includes("/")) {
    const path = isAbsolute(cmd) ? cmd : join(process.cwd(), cmd);
    return isExecutableFile(path) ? path : null;
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, cmd);
    if (isExecutableFile(path)) return path;
  }
  return null;
}

/** A `WhichFn` backed by {@link findExecutable}, caching each answer for `ttlMs`. */
export function cachedWhich(ttlMs = 5_000, lookup: (command: string) => string | null = (c) => findExecutable(c)): WhichFn {
  const cache = new Map<string, { at: number; found: boolean }>();
  return (command) => {
    const now = Date.now();
    const hit = cache.get(command);
    if (hit && now - hit.at < ttlMs) return hit.found;
    const found = lookup(command) !== null;
    cache.set(command, { at: now, found });
    return found;
  };
}
