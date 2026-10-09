/**
 * I-213: group projects (`path: null`), whose chats each pick their own folder at creation
 * (`CreateWorkspaceRequest.folder` → `Workspace.cwd`), the folder-level routes' `workspaceId` /
 * `folder` params, and the project endpoints that need a folder answering 400 for groups.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateWorkspaceResponse, FileSearchResponse, Project, WorkspaceSummary } from "@glade/protocol";
import { FAKE_COMMANDS } from "../src/harness/fake/fake-harness.js";
import { createApp } from "../src/http/app.js";
import { FolderInfoService } from "../src/services/folder-info.js";
import { FsBrowseService } from "../src/services/fs-browse.js";
import { createTestEnv, flush, type TestEnv } from "./helpers.js";

let env: TestEnv;
let home: string;
let outside: string;
let app: ReturnType<typeof createApp>["app"];
const openIn = vi.fn(async () => {});

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "glade-home-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "glade-outside-")));
  env = createTestEnv({ fsBrowse: new FsBrowseService({ home, roots: [] }), openIn });
  const folderInfo = new FolderInfoService({
    harness: () => env.harness,
    scratchDir: join(env.dir, "scratch"),
    projectPath: (id) => env.store.getProject(id)?.path,
    workspaceCwd: (id) => env.store.getWorkspace(id)?.cwd,
    resolveFolder: (folder) => env.service.resolveFolder(folder),
    listFiles: async (cwd) => ({ entries: [{ path: `${cwd.split("/").pop()}.ts`, kind: "file" }], truncated: false }),
  });
  app = createApp({ service: env.service, folderInfo }).app;
  openIn.mockClear();
});
afterEach(async () => {
  await env.cleanup();
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const HOST = { host: "127.0.0.1:4317" };
function req(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { ...HOST, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function json<T>(res: Response | Promise<Response>): Promise<T> {
  return (await (await res).json()) as T;
}
function dir(...parts: string[]): string {
  const path = join(home, ...parts);
  mkdirSync(path, { recursive: true });
  return path;
}
async function createGroup(name = "Checkout A"): Promise<Project> {
  const res = await req("POST", "/api/projects", { name });
  expect(res.status).toBe(200);
  return json<Project>(res);
}
async function errorOf(res: Response | Promise<Response>): Promise<{ status: number; error: string }> {
  const r = await res;
  return { status: r.status, error: ((await r.json()) as { error: string }).error };
}

describe("creating groups", () => {
  it("POST /projects without a path creates a group; a name is required", async () => {
    const group = await createGroup("  Monorepo  ");
    expect(group).toMatchObject({ name: "Monorepo", path: null });
    expect(env.store.getProject(group.id)?.path).toBeNull();
    // Groups never clash with each other (same name, both null paths).
    const other = await createGroup("Monorepo");
    expect(other.id).not.toBe(group.id);
    expect((await json<Project[]>(req("GET", "/api/projects"))).map((p) => p.id).sort()).toEqual([group.id, other.id].sort());
    expect(await errorOf(req("POST", "/api/projects", {}))).toEqual({ status: 400, error: "A group needs a name" });
    expect((await req("POST", "/api/projects", { path: null, name: "  " })).status).toBe(400);
    // A normal project still validates its path.
    expect((await req("POST", "/api/projects", { path: "" })).status).toBe(400);
    expect((await req("POST", "/api/projects", { path: join(home, "missing") })).status).toBe(400);
    const normal = await json<Project>(req("POST", "/api/projects", { path: dir("repo") }));
    expect(normal.path).toBe(join(home, "repo"));
  });
});

describe("chats in a group", () => {
  it("run in the folder picked at creation, titled after it (a user title)", async () => {
    const group = await createGroup();
    const folder = dir("checkout", "admin-web");
    const res = await req("POST", "/api/workspaces", { projectId: group.id, folder, prompt: "fix the header" });
    expect(res.status).toBe(200);
    const { workspace, session } = await json<CreateWorkspaceResponse>(res);
    expect(workspace).toMatchObject({ projectId: group.id, title: "admin-web", titleSource: "user", cwd: folder });
    await flush();
    // The first prompt doesn't rename the chat; tabs inherit its folder.
    expect(env.service.getWorkspaceDetail(workspace.id).workspace.title).toBe("admin-web");
    const tab = await env.service.createSession(workspace.id, {});
    expect(tab.session.workspaceId).toBe(workspace.id);
    expect([...env.harness.openSessions].every((s) => s.cwd === folder)).toBe(true);
    expect(session.session.id).toBeTruthy();
    // Renaming still works.
    expect((await json<WorkspaceSummary>(req("PATCH", `/api/workspaces/${workspace.id}`, { title: "Admin" }))).title).toBe("Admin");
  });

  it("resolves symlinks and `~`", async () => {
    const group = await createGroup();
    const real = dir("real");
    symlinkSync(real, join(home, "link"));
    const viaLink = await json<CreateWorkspaceResponse>(req("POST", "/api/workspaces", { projectId: group.id, folder: join(home, "link") }));
    expect(viaLink.workspace.cwd).toBe(real);
    const viaTilde = await json<CreateWorkspaceResponse>(req("POST", "/api/workspaces", { projectId: group.id, folder: "~/real" }));
    expect(viaTilde.workspace.cwd).toBe(real);
  });

  it("needs a good folder and no worktree", async () => {
    const group = await createGroup();
    const create = (body: Record<string, unknown>) => errorOf(req("POST", "/api/workspaces", { projectId: group.id, ...body }));
    expect(await create({})).toMatchObject({ status: 400, error: expect.stringMatching(/Choose a folder/) });
    expect((await create({ folder: "" })).status).toBe(400);
    expect((await create({ folder: 42 })).status).toBe(400);
    expect((await create({ folder: "relative/path" })).status).toBe(400);
    expect((await create({ folder: join(home, "missing") })).status).toBe(400);
    writeFileSync(join(home, "file.txt"), "x");
    expect((await create({ folder: join(home, "file.txt") })).status).toBe(400);
    expect((await create({ folder: outside })).status).toBe(400);
    // A symlink inside home leading outside is refused too.
    symlinkSync(outside, join(home, "escape"));
    expect((await create({ folder: join(home, "escape") })).status).toBe(400);
    expect(await create({ folder: dir("ok"), worktree: true })).toEqual({ status: 400, error: "Chats in a group project can't work in a worktree" });
    expect(env.store.listWorkspaces()).toEqual([]);
  });

  it("can't change their folder later", async () => {
    const group = await createGroup();
    const folder = dir("a");
    const { workspace } = await json<CreateWorkspaceResponse>(req("POST", "/api/workspaces", { projectId: group.id, folder }));
    expect((await req("PATCH", `/api/workspaces/${workspace.id}`, { folder: dir("b") })).status).toBe(400);
    expect((await req("PATCH", `/api/workspaces/${workspace.id}`, { cwd: dir("b") })).status).toBe(400);
    expect(env.store.getWorkspace(workspace.id)?.cwd).toBe(folder);
  });

  it("folder is refused for normal projects and standalone chats", async () => {
    const project = await json<Project>(req("POST", "/api/projects", { path: dir("repo") }));
    const folder = dir("x");
    expect(await errorOf(req("POST", "/api/workspaces", { projectId: project.id, folder }))).toEqual({
      status: 400,
      error: "Only chats in a group project choose their folder",
    });
    expect((await req("POST", "/api/workspaces", { projectId: null, folder })).status).toBe(400);
    // Without it, normal chats are unchanged.
    const normal = await json<CreateWorkspaceResponse>(req("POST", "/api/workspaces", { projectId: project.id }));
    expect(normal.workspace).toMatchObject({ cwd: project.path, title: "New chat", titleSource: "auto" });
  });
});

describe("folder-level routes", () => {
  it("use workspaceId > folder > projectId", async () => {
    const group = await createGroup();
    const a = dir("a");
    const b = dir("b");
    const { workspace } = await json<CreateWorkspaceResponse>(req("POST", "/api/workspaces", { projectId: group.id, folder: a }));
    const files = (query: string) => json<FileSearchResponse>(req("GET", `/api/files?q=&${query}`));
    expect((await files(`workspaceId=${workspace.id}&folder=${b}&projectId=${group.id}`)).entries[0]!.path).toBe("a.ts");
    expect((await files(`folder=${encodeURIComponent(b)}&projectId=${group.id}`)).entries[0]!.path).toBe("b.ts");
    expect(await json(req("GET", `/api/commands?workspaceId=${workspace.id}`))).toEqual(FAKE_COMMANDS);
    expect(await json(req("GET", `/api/commands?folder=${encodeURIComponent(b)}`))).toEqual(FAKE_COMMANDS);
    expect((await req("GET", `/api/permission-modes?workspaceId=${workspace.id}`)).status).toBe(200);
    expect((await req("GET", `/api/permission-modes?folder=${encodeURIComponent(b)}`)).status).toBe(200);
  });

  it("a group alone lists nothing; unknown chats 404, bad folders 400", async () => {
    const group = await createGroup();
    expect(await json(req("GET", `/api/commands?projectId=${group.id}`))).toEqual([]);
    expect(await json(req("GET", `/api/files?projectId=${group.id}&q=a`))).toEqual({ entries: [], truncated: false });
    expect((await req("GET", `/api/permission-modes?projectId=${group.id}`)).status).toBe(200);
    expect((await req("GET", "/api/commands?workspaceId=nope")).status).toBe(404);
    expect((await req("GET", "/api/files?workspaceId=nope&q=")).status).toBe(404);
    expect((await req("GET", `/api/commands?folder=${encodeURIComponent(outside)}`)).status).toBe(400);
    expect((await req("GET", `/api/files?folder=${encodeURIComponent(join(home, "missing"))}&q=`)).status).toBe(400);
    expect((await req("GET", "/api/permission-modes?folder=relative")).status).toBe(400);
  });
});

describe("project endpoints that need a folder", () => {
  it("answer 400 for groups", async () => {
    const group = await createGroup();
    const noFolder = { status: 400, error: "Group projects have no folder" };
    expect(await errorOf(req("POST", `/api/projects/${group.id}/open`, { app: "finder" }))).toEqual(noFolder);
    expect(openIn).not.toHaveBeenCalled();
    expect(await errorOf(req("GET", `/api/projects/${group.id}/git`))).toEqual(noFolder);
    expect(await errorOf(req("POST", `/api/projects/${group.id}/git/checkout`, { branch: "main" }))).toEqual(noFolder);
    expect(await errorOf(req("POST", `/api/projects/${group.id}/git/branch`, { name: "x" }))).toEqual(noFolder);
    expect(await errorOf(req("POST", `/api/projects/${group.id}/changes/commit`, { message: "m" }))).toEqual(noFolder);
    expect(await errorOf(req("POST", `/api/projects/${group.id}/changes/commit-message`, {}))).toEqual(noFolder);
    // Renaming, reordering and deleting work as for any project.
    expect((await json<Project>(req("PATCH", `/api/projects/${group.id}`, { name: "Renamed" }))).name).toBe("Renamed");
    await req("POST", "/api/workspaces", { projectId: group.id, folder: dir("a") });
    expect((await req("DELETE", `/api/projects/${group.id}`)).status).toBe(204);
    expect(env.store.listWorkspaces()).toEqual([]);
  });
});
