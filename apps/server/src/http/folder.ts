/**
 * Folder-level routes (I-043, I-044, I-050), mounted under `/api` by `createApp`:
 *
 *   GET /commands?<folder>[&harness=][&refresh=1]                 → SlashCommand[] (harness commands for the folder)
 *   GET /files?<folder>&q=[&limit=]                               → FileSearchResponse (`@` mentions)
 *   GET /models/default[?refresh=1][&harness=]                    → HarnessDefaults (I-198: `harness` = that agent's own; 404 when not offered)
 *   GET /permission-modes?<folder>[&harness=][&provider=&model=]  → FolderPermissionModes (I-184)
 *
 * `<folder>` (I-213): `workspaceId=` (that chat's `cwd`) > `folder=` (an absolute folder in the
 * folder browser's area) > `projectId=` (omitted/empty = the scratch folder; a group project alone
 * lists nothing). `harness` omitted = the default agent (I-185).
 */
import { Hono, type Context } from "hono";
import type { FolderInfoService, FolderTarget } from "../services/folder-info.js";

const truthy = (v: string | undefined) => v === "1" || v === "true";

/** The folder a request names (I-213). */
const target = (c: Context): FolderTarget => ({
  projectId: c.req.query("projectId") || null,
  workspaceId: c.req.query("workspaceId") || null,
  folder: c.req.query("folder") || null,
});

export function folderRoutes(folderInfo: FolderInfoService): Hono {
  const api = new Hono();
  api.get("/commands", async (c) =>
    c.json(await folderInfo.listCommands(target(c), truthy(c.req.query("refresh")), c.req.query("harness") || null)),
  );
  api.get("/permission-modes", async (c) => {
    const provider = c.req.query("provider");
    const id = c.req.query("model");
    const model = provider && id ? { provider, id } : null;
    return c.json(await folderInfo.getPermissionModes(target(c), c.req.query("harness") || null, model, truthy(c.req.query("refresh"))));
  });
  api.get("/files", async (c) => {
    const limit = Number(c.req.query("limit") ?? "") || undefined;
    return c.json(await folderInfo.searchFiles(target(c), c.req.query("q") ?? "", limit));
  });
  api.get("/models/default", async (c) => c.json(await folderInfo.getDefaults(truthy(c.req.query("refresh")), c.req.query("harness") || null)));
  return api;
}
