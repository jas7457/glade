/**
 * I-165: folders in the chat list. Store (persisted, migration 7, another server's changes), the
 * REST routes (create / rename / reorder / delete, moving projects and chats in and out, shared
 * project order), and sync (snapshot, replay, check).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Folder, Project, ServerMessage, WorkspaceSummary } from "@glade/protocol";
import { createApp } from "../src/http/app.js";
import { openDatabase, schemaVersion } from "../src/store/db/database.js";
import { MIGRATIONS } from "../src/store/db/migrations/index.js";
import type { SyncSocket } from "../src/services/sync/hub.js";
import { Store, type StoreChange } from "../src/store/store.js";
import { createTestEnv, newChat, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

function addProject(name: string): Project {
  const path = join(env.dir, name);
  mkdirSync(path, { recursive: true });
  return env.service.createProject({ path });
}

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const { app } = createApp({ service: env.service });
  const res = await app.request(path, {
    method,
    headers: { host: "127.0.0.1:4317", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** The top of the sidebar as the web builds it: projects + top-level folders by `sortOrder`, folders followed by their projects. */
function sidebar(): string[] {
  const projects = env.service.listProjects();
  const folders = env.service.listFolders().filter((f) => f.projectId === null);
  const top = [...projects.filter((p) => !p.folderId).map((p) => ({ id: p.id, o: p.sortOrder, name: p.name })), ...folders.map((f) => ({ id: f.id, o: f.sortOrder, name: `[${f.name}]` }))].sort((a, b) => a.o - b.o);
  return top.flatMap((e) => [
    e.name,
    ...projects
      .filter((p) => p.folderId === e.id)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((p) => `  ${p.name}`),
  ]);
}

describe("folders API (I-165)", () => {
  it("creates top-level and project folders at the top of their lists", async () => {
    const a = addProject("a");
    const top = await req<Folder>("POST", "/api/folders", { name: "  Work  " });
    expect(top.status).toBe(200);
    expect(top.body).toMatchObject({ name: "Work", projectId: null, environmentId: env.store.environmentId });
    expect(sidebar()).toEqual(["[Work]", "a"]);

    const inA = await req<Folder>("POST", "/api/folders", { name: "Bugs", projectId: a.id });
    const inA2 = await req<Folder>("POST", "/api/folders", { name: "Ideas", projectId: a.id });
    expect(inA2.body.sortOrder).toBeLessThan(inA.body.sortOrder);
    const listed = await req<Folder[]>("GET", "/api/folders");
    expect(listed.body.map((f) => f.name)).toEqual(["Work", "Ideas", "Bugs"]);
    expect(env.messages.filter((m) => m.type === "folder_upsert")).toHaveLength(3);

    expect((await req("POST", "/api/folders", { name: " " })).status).toBe(400);
    expect((await req("POST", "/api/folders", { name: "x", projectId: "nope" })).status).toBe(404);
  });

  it("renames and reorders a project's folders", async () => {
    const a = addProject("a");
    const f1 = env.service.createFolder({ name: "One", projectId: a.id });
    const f2 = env.service.createFolder({ name: "Two", projectId: a.id });
    expect((await req<Folder>("PATCH", `/api/folders/${f1.id}`, { name: "Uno" })).body.name).toBe("Uno");
    expect((await req("PATCH", "/api/folders/nope", { name: "x" })).status).toBe(404);
    const ordered = await req<Folder[]>("PUT", "/api/folders/order", { projectId: a.id, ids: [f1.id, f2.id] });
    expect(ordered.body.map((f) => [f.name, f.sortOrder])).toEqual([
      ["Uno", 0],
      ["Two", 1],
    ]);
    expect((await req("PUT", "/api/folders/order", { projectId: a.id, ids: [f1.id] })).status).toBe(400);
  });

  it("moves projects in and out of top-level folders (in: at its top; out: right after it)", async () => {
    const a = addProject("a");
    const b = addProject("b");
    const c = addProject("c");
    const work = env.service.createFolder({ name: "Work" });
    expect(sidebar()).toEqual(["[Work]", "c", "b", "a"]);

    expect((await req<Project>("PATCH", `/api/projects/${a.id}`, { folderId: work.id })).body.folderId).toBe(work.id);
    await req("PATCH", `/api/projects/${c.id}`, { folderId: work.id });
    expect(sidebar()).toEqual(["[Work]", "  c", "  a", "b"]);

    await req("PATCH", `/api/projects/${c.id}`, { folderId: null });
    expect(sidebar()).toEqual(["[Work]", "  a", "c", "b"]);

    const projectFolder = env.service.createFolder({ name: "Inner", projectId: b.id });
    expect((await req("PATCH", `/api/projects/${a.id}`, { folderId: projectFolder.id })).status).toBe(400);
    expect((await req("PATCH", `/api/projects/${a.id}`, { folderId: "nope" })).status).toBe(404);
    expect((await req("PATCH", `/api/projects/${a.id}`, { folderId: 3 })).status).toBe(400);
  });

  it("PUT /api/projects/order takes top-level folder ids in the same order", async () => {
    const a = addProject("a");
    const b = addProject("b");
    const work = env.service.createFolder({ name: "Work" });
    const res = await req("PUT", "/api/projects/order", { ids: [a.id, work.id, b.id] });
    expect(res.status).toBe(200);
    expect(sidebar()).toEqual(["a", "[Work]", "b"]);
    // Without the folder (an older client) it still works.
    expect((await req("PUT", "/api/projects/order", { ids: [b.id, a.id] })).status).toBe(200);
    // Every project is still required; project folders aren't part of this order.
    expect((await req("PUT", "/api/projects/order", { ids: [a.id, work.id] })).status).toBe(400);
    const inner = env.service.createFolder({ name: "Inner", projectId: a.id });
    expect((await req("PUT", "/api/projects/order", { ids: [a.id, b.id, inner.id] })).status).toBe(400);
  });

  it("moves chats in and out: standalone chats into top-level folders, project chats into their project's", async () => {
    const a = addProject("a");
    const b = addProject("b");
    const top = env.service.createFolder({ name: "Top" });
    const inA = env.service.createFolder({ name: "A", projectId: a.id });
    const inB = env.service.createFolder({ name: "B", projectId: b.id });
    const standalone = await newChat(env);
    const chatA = await newChat(env, { projectId: a.id });

    const moved = await req<WorkspaceSummary>("PATCH", `/api/workspaces/${standalone.wid}`, { folderId: top.id });
    expect(moved.status).toBe(200);
    expect(moved.body.folderId).toBe(top.id);
    expect((await req<WorkspaceSummary>("PATCH", `/api/workspaces/${chatA.wid}`, { folderId: inA.id })).body.folderId).toBe(inA.id);

    expect((await req("PATCH", `/api/workspaces/${standalone.wid}`, { folderId: inA.id })).status).toBe(400);
    expect((await req("PATCH", `/api/workspaces/${chatA.wid}`, { folderId: inB.id })).status).toBe(400);
    expect((await req("PATCH", `/api/workspaces/${chatA.wid}`, { folderId: top.id })).status).toBe(400);
    expect((await req("PATCH", `/api/workspaces/${chatA.wid}`, { folderId: "nope" })).status).toBe(404);

    expect((await req<WorkspaceSummary>("PATCH", `/api/workspaces/${chatA.wid}`, { folderId: null })).body.folderId).toBeNull();
  });

  it("deleting a folder moves its contents back out; nothing else is deleted", async () => {
    const a = addProject("a");
    const b = addProject("b");
    const c = addProject("c");
    const work = env.service.createFolder({ name: "Work" });
    await req("PUT", "/api/projects/order", { ids: [c.id, work.id, b.id, a.id] });
    env.service.updateProject(a.id, { folderId: work.id });
    env.service.updateProject(b.id, { folderId: work.id });
    const chat = await newChat(env);
    await env.service.updateWorkspace(chat.wid, { folderId: work.id });
    expect(sidebar()).toEqual(["c", "[Work]", "  b", "  a"]);
    env.messages.length = 0;

    expect((await req("DELETE", `/api/folders/${work.id}`)).status).toBe(204);
    // Its projects take its place.
    expect(sidebar()).toEqual(["c", "b", "a"]);
    expect(env.service.listProjects()).toHaveLength(3);
    expect(env.service.listWorkspaces().find((w) => w.id === chat.wid)?.folderId).toBeNull();
    const types = env.messages.map((m) => m.type);
    expect(types).toContain("folder_removed");
    expect(types).toContain("workspace_upsert");
    expect(env.messages.filter((m): m is Extract<ServerMessage, { type: "project_upsert" }> => m.type === "project_upsert").every((m) => !m.project.folderId)).toBe(true);
    expect((await req("DELETE", `/api/folders/${work.id}`)).status).toBe(404);
  });

  it("deleting a project deletes its folders", async () => {
    const a = addProject("a");
    const inA = env.service.createFolder({ name: "A", projectId: a.id });
    env.service.createFolder({ name: "Top" });
    await env.service.deleteProject(a.id);
    expect(env.service.listFolders().map((f) => f.name)).toEqual(["Top"]);
    expect(env.messages.some((m) => m.type === "folder_removed" && m.folderId === inA.id)).toBe(true);
  });

  it("the shell snapshot carries the folders", () => {
    env.service.createFolder({ name: "Top" });
    expect(env.service.shellSnapshot().folders?.map((f) => f.name)).toEqual(["Top"]);
  });
});

describe("folders in the store (I-165)", () => {
  it("migration 7 adds the folders table; folders and memberships survive a reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-folders-"));
    try {
      const db = openDatabase(join(dir, "x.db"), MIGRATIONS.slice(0, 6));
      expect(schemaVersion(db)).toBe(6);
      db.close();
      const upgraded = openDatabase(join(dir, "x.db"));
      expect(schemaVersion(upgraded)).toBe(7);
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'folders'").get()).toBeTruthy();
      upgraded.close();

      const a = addProject("a");
      const folder = env.service.createFolder({ name: "Work" });
      env.service.updateProject(a.id, { folderId: folder.id });
      const reopened = new Store(env.store.dataDir, 0);
      expect(reopened.listFolders()).toEqual([env.store.getFolder(folder.id)]);
      expect(reopened.getProject(a.id)?.folderId).toBe(folder.id);
      reopened.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("another server's folder changes are reported (StoreChange.folders)", () => {
    const other = new Store(env.store.dataDir, 0, { serverId: "other" });
    try {
      const changes: StoreChange[] = [];
      env.store.onExternalChange((c) => changes.push(c));
      const folder: Folder = { id: "f1", name: "There", projectId: null, sortOrder: 0, createdAt: 1 };
      other.upsertFolder(folder);
      env.store.reload();
      expect(changes.at(-1)?.folders.upserted).toEqual([folder]);
      expect(env.store.getFolder("f1")).toEqual(folder);
      other.removeFolders(["f1"]);
      env.store.reload();
      expect(changes.at(-1)?.folders.removed).toEqual(["f1"]);
      expect(env.store.getFolder("f1")).toBeUndefined();
    } finally {
      other.dispose();
    }
  });
});

class TestSocket implements SyncSocket {
  readonly sent: ServerMessage[] = [];
  send(data: string): void {
    const m = JSON.parse(data) as ServerMessage;
    this.sent.push(...(m.type === "batch" ? m.messages : [m]));
  }
  bufferedAmount(): number {
    return 0;
  }
  close(): void {}
}

describe("folders over sync (I-165)", () => {
  it("snapshot and live check include folders; changes are pushed and replayed with seqs", () => {
    const early = env.service.createFolder({ name: "Early" });
    const socket = new TestSocket();
    const client = env.service.sync.connect(socket);
    client.subscribeShell();
    env.service.sync.tick();
    const snapshot = socket.sent.find((m) => m.type === "snapshot" && m.scope === "shell");
    expect(snapshot?.type === "snapshot" && snapshot.scope === "shell" && snapshot.shell.folders?.map((f) => f.id)).toEqual([early.id]);
    const live = socket.sent.find((m) => m.type === "live" && m.scope === "shell");
    expect(live?.type === "live" && live.scope === "shell" && live.check.folders).toEqual([early.id]);
    const after = env.store.headSeq;
    socket.sent.length = 0;

    const late = env.service.createFolder({ name: "Late" });
    env.service.deleteFolder(early.id);
    env.service.sync.tick();
    const pushed = socket.sent.filter((m) => m.type === "folder_upsert" || m.type === "folder_removed");
    expect(pushed.map((m) => m.type)).toEqual(["folder_upsert", "folder_removed"]);
    expect(pushed.every((m) => typeof m.seq === "number" && typeof m.prev === "number")).toBe(true);

    // A client that comes back after `after` gets both replayed.
    const again = new TestSocket();
    env.service.sync.connect(again).subscribeShell(after);
    env.service.sync.tick();
    const replayed = again.sent.filter((m) => m.type === "folder_upsert" || m.type === "folder_removed");
    expect(replayed).toEqual(expect.arrayContaining([expect.objectContaining({ type: "folder_upsert", folder: expect.objectContaining({ id: late.id }) }), expect.objectContaining({ type: "folder_removed", folderId: early.id })]));
  });
});
