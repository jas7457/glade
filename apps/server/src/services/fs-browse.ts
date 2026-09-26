/**
 * Folder browsing for the project picker: lists the subdirectories of a folder.
 */
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { DirectoryListing } from "@pi-ui/protocol";
import { HttpError } from "./app-service.js";

/** Expand a leading `~` and resolve to an absolute path. Empty → home directory. */
export function expandPath(input: string | undefined): string {
  const trimmed = input?.trim();
  if (!trimmed) return homedir();
  return resolve(trimmed.replace(/^~(?=$|[/\\])/, homedir()));
}

/** Subdirectories of `input` (hidden ones skipped), sorted case-insensitively. */
export async function listDirectories(input: string | undefined): Promise<DirectoryListing> {
  const path = expandPath(input);
  let isDir = false;
  try {
    isDir = (await stat(path)).isDirectory();
  } catch {
    /* missing or unreadable */
  }
  if (!isDir) throw new HttpError(400, `Not a folder: ${path}`);

  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch (err) {
    throw new HttpError(400, `Cannot read folder: ${(err as Error).message}`);
  }

  const entries: DirectoryListing["entries"] = [];
  for (const d of dirents) {
    if (d.name.startsWith(".")) continue;
    const full = join(path, d.name);
    let dir = d.isDirectory();
    if (!dir && d.isSymbolicLink()) {
      // Follow symlinks so linked folders are browsable too.
      dir = await stat(full).then((s) => s.isDirectory(), () => false);
    }
    if (dir) entries.push({ name: d.name, path: full });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));

  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, entries };
}
