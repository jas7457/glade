/**
 * Display helpers for file paths in one-line UI (I-152, I-158): tool rows show a path inside the
 * chat's folder relative to it (`packages/protocol/src/api.ts`, the folder itself as `.`), other
 * paths `~`-shortened. Pure; the full path goes in a tooltip.
 */

/** The home folder implied by a folder path (`/Users/<name>` or `/home/<name>`), or null. */
export function homeOf(cwd: string | null | undefined): string | null {
  return cwd ? (/^\/(?:Users|home)\/[^/]+/.exec(cwd)?.[0] ?? null) : null;
}

/** Collapse `.`/`..`/duplicate slashes in an absolute path (`..` never climbs above `/`). */
function normalizeAbsolute(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/**
 * A tool's path as an absolute path: `~`/`$HOME` expanded with `home`, a leading `@` (pi's file
 * mention syntax) dropped, relative paths resolved against `cwd`. Returns the input unchanged when
 * it can't be resolved (relative without a `cwd`, `~` without a `home`).
 */
export function resolvePath(path: string, cwd?: string | null, home?: string | null): string {
  let p = path.trim().replace(/^@/, "");
  const homeDir = home?.replace(/\/+$/, "");
  if (homeDir && (p === "~" || p.startsWith("~/"))) p = homeDir + p.slice(1);
  else if (homeDir && (p === "$HOME" || p.startsWith("$HOME/"))) p = homeDir + p.slice(5);
  if (p.startsWith("/")) return normalizeAbsolute(p);
  const base = cwd?.replace(/\/+$/, "");
  if (!base || p.startsWith("~") || p.startsWith("$")) return path;
  return normalizeAbsolute(`${base}/${p}`);
}

/**
 * A path for a one-line label: relative to the chat's folder `cwd` when inside it (the folder
 * itself is `.`), else `~`-shortened, else as is. Without a `cwd` the path is only `~`-shortened.
 */
export function displayPath(path: string, cwd?: string | null, home?: string | null): string {
  if (!path) return path;
  const abs = resolvePath(path, cwd, home);
  if (!abs.startsWith("/")) return path;
  const base = cwd ? normalizeAbsolute(cwd) : null;
  if (base && abs === base) return ".";
  if (base && base !== "/" && abs.startsWith(`${base}/`)) return abs.slice(base.length + 1);
  const homeDir = home ? normalizeAbsolute(home) : null;
  if (homeDir && homeDir !== "/" && (abs === homeDir || abs.startsWith(`${homeDir}/`))) return `~${abs.slice(homeDir.length)}`;
  return abs;
}
