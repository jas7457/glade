/**
 * Folder browser backend (I-124, design: docs/design/environments-and-store.md §3.4). Lists the
 * sub-directories of a folder on this host and creates folders ("New Folder"), so any client
 * (including one on another device) can pick a project folder without a native dialog.
 *
 * Browsing is limited to the host user's home folder and `/Volumes` (the "allowed area"). The
 * check uses real paths, so a symlink inside home that points elsewhere is refused (403), and
 * symlinked entries that lead outside are left out of listings.
 */
import { lstat, mkdir as fsMkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { FsBrowseEntry, FsBrowseResult } from "@glade/protocol";

/** Most entries one listing returns (after sorting). */
export const MAX_BROWSE_ENTRIES = 2000;

export class FsBrowseError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface FsBrowseOptions {
  /** The host user's home folder (default: `os.homedir()`). */
  home?: string;
  /** Extra allowed roots besides home (default: `/Volumes`). */
  roots?: string[];
}

export interface BrowseOptions {
  /** Include folders whose name starts with a dot. */
  hidden?: boolean;
}

const isInside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export class FsBrowseService {
  readonly home: string;
  private readonly roots: string[];
  private realRoots: Promise<string[]> | null = null;

  constructor(options: FsBrowseOptions = {}) {
    this.home = resolve(options.home ?? homedir());
    this.roots = [this.home, ...(options.roots ?? ["/Volumes"]).map((r) => resolve(r))];
  }

  /** `~`/empty → home, `~/x` → home/x; anything else must be absolute. Normalized. */
  expand(input: string | undefined | null): string {
    const raw = (input ?? "").trim();
    if (!raw || raw === "~") return this.home;
    if (raw.startsWith("~/")) return resolve(this.home, raw.slice(2));
    if (!isAbsolute(raw)) throw new FsBrowseError(400, "Use an absolute path (starting with / or ~)");
    return resolve(raw);
  }

  async browse(input: string | undefined | null, options: BrowseOptions = {}): Promise<FsBrowseResult> {
    let path = this.expand(input);
    const real = await this.requireAllowed(path);
    // Reached through a symlink from outside the area (e.g. /tmp/link → ~/code): show the real
    // path so "parent" stays inside the area.
    if (!this.roots.some((root) => isInside(path, root))) path = real;
    const parent = this.roots.includes(path) || (await this.isRealRoot(path)) ? null : dirname(path);

    let names: import("node:fs").Dirent[];
    try {
      names = await readdir(path, { withFileTypes: true });
    } catch (err) {
      return { path, parent, entries: [], isGitRepo: false, error: describeError(err) };
    }

    const candidates = names
      .filter((d) => (options.hidden || !d.name.startsWith(".")) && (d.isDirectory() || d.isSymbolicLink()))
      .sort((a, b) => compareNames(a.name, b.name));

    const entries: FsBrowseEntry[] = [];
    const isGitRepo = names.some((d) => d.name === ".git");
    // Symlinks need a stat to know whether they lead to an allowed folder; cap the work.
    for (let i = 0; i < candidates.length && entries.length < MAX_BROWSE_ENTRIES; i += 64) {
      const batch = candidates.slice(i, i + 64);
      const results = await Promise.all(batch.map((d) => this.entry(path, d)));
      for (const e of results) if (e && entries.length < MAX_BROWSE_ENTRIES) entries.push(e);
    }
    return { path, parent, entries, isGitRepo };
  }

  /** Create `path` (its parent must exist; never overwrites). */
  async mkdir(input: string): Promise<FsBrowseEntry> {
    const path = this.expand(input);
    const name = basename(path);
    if (!name || name === "." || name === "..") throw new FsBrowseError(400, "Enter a folder name");
    const parent = dirname(path);
    let parentStat;
    try {
      parentStat = await stat(parent);
    } catch {
      throw new FsBrowseError(404, "The enclosing folder doesn't exist");
    }
    if (!parentStat.isDirectory()) throw new FsBrowseError(400, "The enclosing path isn't a folder");
    await this.requireAllowed(path);
    try {
      await fsMkdir(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") throw new FsBrowseError(409, `“${name}” already exists`);
      if (code === "EACCES" || code === "EPERM") throw new FsBrowseError(403, "Glade doesn't have permission to create a folder here");
      throw err;
    }
    return { name, path, isGitRepo: false, hidden: name.startsWith(".") };
  }

  /**
   * The real path of `input` when it's an existing folder inside the allowed area (I-213: a group
   * chat's folder). Symlinks are resolved, so one leading outside the area is refused. Errors:
   * 400 (relative, missing, not a folder), 403 (outside the area).
   */
  async requireFolder(input: string): Promise<string> {
    if (!input.trim()) throw new FsBrowseError(400, "Choose a folder");
    const path = this.expand(input);
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      throw new FsBrowseError(400, `This folder doesn't exist: ${path}`);
    }
    if (!(await this.isAllowedReal(real))) throw new FsBrowseError(403, "Folders must be inside your home folder or /Volumes");
    if (!(await stat(real)).isDirectory()) throw new FsBrowseError(400, `Not a folder: ${path}`);
    return real;
  }

  // -------------------------------------------------------------------------------------------

  private async entry(dir: string, d: import("node:fs").Dirent): Promise<FsBrowseEntry | null> {
    const path = join(dir, d.name);
    if (d.isSymbolicLink()) {
      try {
        if (!(await stat(path)).isDirectory()) return null;
        if (!(await this.isAllowedReal(await realpath(path)))) return null;
      } catch {
        return null; // dangling link
      }
    }
    return { name: d.name, path, isGitRepo: await exists(join(path, ".git")), hidden: d.name.startsWith(".") };
  }

  /** 403 unless the real location of `path` (or of its nearest existing ancestor) is allowed. */
  private async requireAllowed(path: string): Promise<string> {
    const real = await realLocation(path);
    if (!(await this.isAllowedReal(real))) {
      throw new FsBrowseError(403, "Browsing is limited to your home folder and /Volumes");
    }
    return real;
  }

  private async isAllowedReal(real: string): Promise<boolean> {
    return (await this.getRealRoots()).some((root) => isInside(real, root));
  }

  private async isRealRoot(path: string): Promise<boolean> {
    return (await this.getRealRoots()).includes(path);
  }

  private getRealRoots(): Promise<string[]> {
    this.realRoots ??= Promise.all(this.roots.map((r) => realpath(r).catch(() => r)));
    return this.realRoots;
  }
}

/** Case-insensitive, number-aware (Finder-like) name order. */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
}

/** realpath of `path`, or of its nearest existing ancestor with the rest appended. */
async function realLocation(path: string): Promise<string> {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...rest);
    } catch {
      const up = dirname(current);
      if (up === current) return path;
      rest.unshift(basename(current));
      current = up;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function describeError(err: unknown): string {
  switch ((err as NodeJS.ErrnoException).code) {
    case "ENOENT":
      return "This folder doesn't exist.";
    case "ENOTDIR":
      return "This isn't a folder.";
    case "EACCES":
    case "EPERM":
      return "Glade doesn't have permission to read this folder.";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}
