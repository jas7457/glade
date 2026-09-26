/** Pure helpers for the Add Project dialog. */

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

/** Breadcrumb segments for a path: [{ name, path }], starting at "/". */
export function pathSegments(path: string): Array<{ name: string; path: string }> {
  const parts = path.split("/").filter(Boolean);
  const out = [{ name: "/", path: "/" }];
  parts.forEach((name, i) => out.push({ name, path: `/${parts.slice(0, i + 1).join("/")}` }));
  return out;
}
