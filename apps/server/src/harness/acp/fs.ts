/**
 * The client side of ACP's `fs/read_text_file` / `fs/write_text_file` (I-119), restricted to the
 * session's folder: paths must be absolute (the spec requires it) and, after resolving symlinks,
 * inside `cwd`. Anything else is refused with an error the agent sees.
 */
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class FsAccessError extends Error {}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve the longest existing prefix of `path` through symlinks (the rest can't be a link yet). */
async function realpathLoose(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return join(await realpathLoose(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}

/** The real path of `path` if it's inside `cwd`; throws {@link FsAccessError} otherwise. */
export async function checkedPath(cwd: string, path: string): Promise<string> {
  if (!isAbsolute(path)) throw new FsAccessError(`Path must be absolute: ${path}`);
  const root = await realpathLoose(resolve(cwd));
  const real = await realpathLoose(resolve(path));
  if (!inside(root, real)) throw new FsAccessError(`Access denied: ${path} is outside the chat's folder (${cwd})`);
  return real;
}

/** `fs/read_text_file`: the file's text, or `limit` lines from 1-based `line`. */
export async function readTextFile(cwd: string, path: string, line?: number | null, limit?: number | null): Promise<string> {
  const real = await checkedPath(cwd, path);
  const text = await readFile(real, "utf8");
  if (line == null && limit == null) return text;
  const lines = text.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit == null ? lines.length : start + Math.max(0, limit);
  return lines.slice(start, end).join("\n");
}

/** `fs/write_text_file`: create or overwrite the file (and its folders), atomically. */
export async function writeTextFile(cwd: string, path: string, content: string): Promise<void> {
  const real = await checkedPath(cwd, path);
  await mkdir(dirname(real), { recursive: true });
  const tmp = `${real}.glade-${process.pid}-${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, real);
}
