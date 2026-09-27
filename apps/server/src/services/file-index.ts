/**
 * File listing + ranking for `@` mentions (I-044). Harness-agnostic.
 *
 * `listFolderFiles` lists a folder's files relative to it: `git ls-files -co --exclude-standard`
 * in a git work tree (tracked + untracked, `.gitignore` respected), else a bounded walk that
 * skips heavy/generated folders. Directories are derived from the file paths. `rankFiles` is a
 * pure fuzzy ranker: basename matches beat path matches, shorter/shallower paths break ties.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FileEntry } from "@glade/protocol";

const execFileAsync = promisify(execFile);

/** Upper bound of files indexed per folder. */
export const MAX_FILES = 50_000;
const WALK_MAX_DEPTH = 12;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "out", ".next", ".turbo", ".cache", "target", ".venv", "__pycache__", ".DS_Store"]);

export interface FolderFiles {
  entries: FileEntry[];
  truncated: boolean;
}

export async function listFolderFiles(cwd: string): Promise<FolderFiles> {
  const files = (await gitFiles(cwd)) ?? (await walkFiles(cwd));
  const truncated = files.length > MAX_FILES;
  return { entries: withDirs(truncated ? files.slice(0, MAX_FILES) : files), truncated };
}

/** `null` when `cwd` isn't inside a git work tree (or git isn't available). */
async function gitFiles(cwd: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd,
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const seen = new Set<string>();
    for (const p of stdout.split("\0")) if (p) seen.add(p);
    return [...seen];
  } catch {
    return null;
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (out.length > MAX_FILES || depth > WALK_MAX_DEPTH) return;
    let dirents;
    try {
      dirents = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (out.length > MAX_FILES) return;
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) await walk(path, depth + 1);
      } else if (d.isFile() && d.name !== ".DS_Store") {
        out.push(path);
      }
    }
  };
  await walk("", 0);
  return out;
}

/** Files plus every directory that contains one. */
function withDirs(files: string[]): FileEntry[] {
  const dirs = new Set<string>();
  for (const f of files) {
    for (let i = f.indexOf("/"); i !== -1; i = f.indexOf("/", i + 1)) dirs.add(f.slice(0, i));
  }
  return [...[...dirs].map((path) => ({ path, kind: "dir" as const })), ...files.map((path) => ({ path, kind: "file" as const }))];
}

// ---------------------------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------------------------

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const depth = (p: string) => p.split("/").length;

/** Characters of `q` in order in `text`; returns a gap penalty, or `null`. */
function subsequence(q: string, text: string): number | null {
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (let j = 0; j < text.length && i < q.length; j++) {
    if (text[j] === q[i]) {
      if (last !== -1 && j !== last + 1) gaps++;
      last = j;
      i++;
    }
  }
  return i === q.length ? gaps : null;
}

/** Scores from here on are loose (path subsequence) matches. */
const LOOSE_SCORE = 200;

/** Lower is better; `null` = no match. */
export function scoreFile(entry: FileEntry, query: string): number | null {
  const q = query.toLowerCase();
  if (!q) return depth(entry.path) * 10;
  const path = entry.path.toLowerCase();
  const full = entry.kind === "dir" ? `${path}/` : path;
  if (q.includes("/")) {
    // Path-style query (e.g. "src/ap"): match against the full path.
    if (full === q) return null; // the directory being completed itself
    if (full.startsWith(q)) return 100 + (depth(path) - depth(q)) * 10;
    if (full.includes(q)) return 300;
    const gaps = subsequence(q, full);
    return gaps === null ? null : 500 + gaps;
  }
  const base = basename(path);
  if (base === q) return 0;
  if (base.startsWith(q)) return 10;
  if (base.includes(q)) return 20;
  if (path.includes(q)) return 40;
  const baseGaps = subsequence(q, base);
  if (baseGaps !== null) return 60 + baseGaps;
  const gaps = subsequence(q, path);
  return gaps === null ? null : 200 + gaps;
}

/** Best `limit` matches: score, then shorter basename, then shallower, then alphabetical. */
export function rankFiles(entries: FileEntry[], query: string, limit: number): FileEntry[] {
  const q = query.trim().replace(/^\.\//, "");
  if (!q) {
    // Nothing typed yet: the top of the tree, folders first, A→Z.
    return [...entries]
      .sort((a, b) => depth(a.path) - depth(b.path) || (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1) || a.path.localeCompare(b.path))
      .slice(0, limit);
  }
  const scored: Array<{ entry: FileEntry; score: number }> = [];
  for (const entry of entries) {
    const score = scoreFile(entry, q);
    if (score !== null) scored.push({ entry, score });
  }
  // Loose path subsequences are only a fallback; they're noise next to real matches.
  const real = scored.filter((s) => s.score < LOOSE_SCORE);
  const ranked = real.length ? real : scored;
  ranked.sort(
    (a, b) =>
      a.score - b.score ||
      basename(a.entry.path).length - basename(b.entry.path).length ||
      depth(a.entry.path) - depth(b.entry.path) ||
      (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0),
  );
  return ranked.slice(0, limit).map((s) => s.entry);
}
