/** Pure helpers for the Create Project dialog. */

/** Returns an error message, or null if the path looks usable (absolute or ~-relative). */
export function validateProjectPath(path: string): string | null {
  const p = path.trim();
  if (!p) return "Choose a folder.";
  if (!(p.startsWith("/") || p === "~" || p.startsWith("~/"))) return "Use an absolute path (starting with / or ~).";
  return null;
}

/** Last path segment, used as the default project name. */
export function folderName(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "~") return trimmed || "/";
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/**
 * The project name after a folder is picked: the folder's name, unless the user typed their own
 * (i.e. the current name is non-empty and differs from what we auto-filled last time).
 */
export function nameAfterPick(current: string, lastAutoFilled: string | null, folder: string): string {
  return !current.trim() || current === lastAutoFilled ? folderName(folder) : current;
}
