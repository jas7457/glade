/**
 * Folder-level routes (I-043, I-044, I-050), mounted under `/api` by `createApp`:
 *
 *   GET /commands?projectId=[&refresh=1]    → SlashCommand[] (harness commands for the folder)
 *   GET /files?projectId=&q=[&limit=]       → FileSearchResponse (`@` mentions)
 *   GET /models/default[?refresh=1]         → HarnessDefaults
 *
 * `projectId` omitted/empty = the scratch folder.
 */
import { Hono } from "hono";
import type { FolderInfoService } from "../services/folder-info.js";

const truthy = (v: string | undefined) => v === "1" || v === "true";

export function folderRoutes(folderInfo: FolderInfoService): Hono {
  const api = new Hono();
  api.get("/commands", async (c) => c.json(await folderInfo.listCommands(c.req.query("projectId") || null, truthy(c.req.query("refresh")))));
  api.get("/files", async (c) => {
    const limit = Number(c.req.query("limit") ?? "") || undefined;
    return c.json(await folderInfo.searchFiles(c.req.query("projectId") || null, c.req.query("q") ?? "", limit));
  });
  api.get("/models/default", async (c) => c.json(await folderInfo.getDefaults(truthy(c.req.query("refresh")))));
  return api;
}
