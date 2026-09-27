/**
 * Changes panel routes (I-097), mounted under `/api` by `createApp`. The folder is always the
 * workspace's `cwd` (clients never send a folder); file paths must be ones git reports changed.
 *
 *   GET  /workspaces/:id/changes                → GitChangesResponse
 *   GET  /workspaces/:id/changes/diff?path=     → GitFileDiffResponse
 *   POST /workspaces/:id/changes/revert         → GitChangesResponse    ({ paths })
 *   POST /workspaces/:id/changes/commit         → CommitChangesResponse ({ message, paths? })
 *   POST /workspaces/:id/changes/commit-message → CommitMessageResponse ({ paths? })
 *   POST /projects/:id/changes/commit           → CommitChangesResponse ({ message, paths? })  (I-105)
 *   POST /projects/:id/changes/commit-message   → CommitMessageResponse ({ paths? })           (I-105)
 *
 * The project routes commit in the project's own folder (the new-chat screen's "Commit your
 * changes to switch branch" dialog, which has no workspace yet).
 *
 * Behaviour lives in `services/git-changes.ts`.
 */
import { Hono, type Context } from "hono";
import type { CommitChangesRequest, CommitMessageRequest, RevertChangesRequest } from "@glade/protocol";
import { HttpError, type AppService } from "../services/app-service.js";
import type { GitChangesService } from "../services/git-changes.js";

export function changesRoutes(service: AppService, git: GitChangesService): Hono {
  const api = new Hono();
  const cwd = (c: Context) => service.getWorkspaceDetail(c.req.param("id")!).workspace.cwd;

  api.get("/workspaces/:id/changes", async (c) => c.json(await git.status(cwd(c))));
  api.get("/workspaces/:id/changes/diff", async (c) => {
    const path = c.req.query("path");
    if (!path) throw new HttpError(400, "path is required");
    return c.json(await git.diff(cwd(c), path));
  });
  api.post("/workspaces/:id/changes/revert", async (c) => {
    const body = await readJson<RevertChangesRequest>(c);
    requirePaths(body.paths);
    return c.json(await git.revert(cwd(c), body.paths));
  });
  const projectPath = (c: Context) => {
    const project = service.listProjects().find((p) => p.id === c.req.param("id"));
    if (!project) throw new HttpError(404, "Project not found");
    return project.path;
  };
  for (const [scope, folder] of [["workspaces", cwd], ["projects", projectPath]] as const) {
    api.post(`/${scope}/:id/changes/commit`, async (c) => {
      const body = await readJson<CommitChangesRequest>(c);
      if (typeof body.message !== "string" || !body.message.trim()) throw new HttpError(400, "message is required");
      if (body.paths !== undefined) requirePaths(body.paths);
      return c.json(await git.commit(folder(c), body.message, body.paths));
    });
    api.post(`/${scope}/:id/changes/commit-message`, async (c) => {
      const text = (await c.req.text()).trim();
      const body = text ? await readJson<CommitMessageRequest>(c, text) : {};
      if (body.paths !== undefined) requirePaths(body.paths);
      return c.json(await git.commitMessage(folder(c), body.paths));
    });
  }
  return api;
}

async function readJson<T>(c: Context, text?: string): Promise<Partial<T>> {
  let body: unknown;
  try {
    body = JSON.parse(text ?? (await c.req.text()));
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Request body must be a JSON object");
  return body as Partial<T>;
}

function requirePaths(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((p) => typeof p === "string")) {
    throw new HttpError(400, "paths must be a non-empty array of strings");
  }
}
