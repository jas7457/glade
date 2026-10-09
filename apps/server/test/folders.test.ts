/**
 * I-165 / I-202: folders in the chat list and its manual order. Store (persisted, migration 7,
 * another server's changes), the REST routes (create / rename / delete, moving chats in and out,
 * `PUT /workspaces/order`), and sync (snapshot, replay, check).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareListOrder, type Folder, type Project, type ReorderChatListResponse, type ServerMessage, type WorkspaceSummary } from "@glade/protocol";
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

/**
 * A chat list as the web shows it (I-202): pinned chats, then chats and folders by `sortOrder`
 * (missing first), each folder followed by its chats ("  " + title). Folders are "[name]".
 */
function list(projectId: string | null): string[] {
  const chats = env.service.listWorkspaces().filter((w) => w.projectId === projectId);
  const folders = env.service.listFolders().filter((f) => f.projectId === projectId);
  const folderOf = (w: WorkspaceSummary) => (w.folderId && folders.some((f) => f.id === w.folderId) ? w.folderId : null);
  const place = <T extends { id: string; sortOrder?: number; createdAt: number; pinned?: boolean; pinOrder?: number }>(items: T[]) =>
    [...items].sort((x, y) => Number(!!y.pinned) - Number(!!x.pinned) || (x.pinned && y.pinned ? (x.pinOrder ?? 0) - (y.pinOrder ?? 0) : 0) || compareListOrder(x, y));
  const top = place<{ id: string; sortOrder?: number; createdAt: number; pinned?: boolean; pinOrder?: number; label: string; folder?: boolean }>([
    ...chats.filter((w) => folderOf(w) === null).map((w) => ({ ...w, label: w.title })),
    ...folders.map((f) => ({ ...f, label: `[${f.name}]`, folder: true })),
  ]);
  return top.flatMap((e) => [e.label, ...(e.folder ? place(chats.filter((w) => folderOf(w) === e.id)).map((w) => `  ${w.title}`) : [])]);
}

async function chat(title: string, projectId: string | null = null): Promise<string> {
  const { wid } = await newChat(env, { projectId });
  await env.service.updateWorkspace(wid, { title });
  return wid;
}

describe("folders API (I-165, I-202)", () => {
  it("creates Chats-section and project folders at the top of their lists, above the chats", async () => {
    const a = addProject("a");
    await chat("s1");
    const top = await req<Folder>("POST", "/api/folders", { name: "  Work  " });
    expect(top.status).toBe(200);
    expect(top.body).toMatchObject({ name: "Work", projectId: null, environmentId: env.store.environmentId });
    expect(list(null)).toEqual(["[Work]", "s1"]);

    await chat("a1", a.id);
    const inA = await req<Folder>("POST", "/api/folders", { name: "Bugs", projectId: a.id });
    const inA2 = await req<Folder>("POST", "/api/folders", { name: "Ideas", projectId: a.id });
    expect(inA2.body.sortOrder).toBeLessThan(inA.body.sortOrder);
    expect(list(a.id)).toEqual(["[Ideas]", "[Bugs]", "a1"]);
    const listed = await req<Folder[]>("GET", "/api/folders");
    expect(listed.body.map((f) => f.name)).toEqual(["Work", "Ideas", "Bugs"]);
    expect(env.messages.filter((m) => m.type === "folder_upsert")).toHaveLength(3);

    expect((await req("POST", "/api/folders", { name: " " })).status).toBe(400);
    expect((await req("POST", "/api/folders", { name: "x", projectId: "nope" })).status).toBe(404);
    expect((await req<Folder>("PATCH", `/api/folders/${inA.body.id}`, { name: "Uno" })).body.name).toBe("Uno");
    expect((await req("PATCH", "/api/folders/nope", { name: "x" })).status).toBe(404);
    // The old folder-order route is gone (PUT /workspaces/order replaces it).
    expect((await req("PUT", "/api/folders/order", { projectId: a.id, ids: [inA.body.id] })).status).toBe(404);
  });

  it("new chats go to the top of their list; activity never moves them", async () => {
    const a = addProject("a");
    const folder = env.service.createFolder({ name: "F", projectId: a.id });
    await chat("one", a.id);
    await chat("two", a.id);
    expect(list(a.id)).toEqual(["two", "one", "[F]"]);
    const s = await chat("standalone");
    expect(list(null)).toEqual(["standalone"]);
    expect(env.store.getWorkspace(s)?.sortOrder).toBe(0);
    void folder;
  });

  it("projects can't go in folders any more", async () => {
    const a = addProject("a");
    const work = env.service.createFolder({ name: "Work" });
    expect((await req("PATCH", `/api/projects/${a.id}`, { folderId: work.id })).status).toBe(400);
    expect((await req("PATCH", `/api/projects/${a.id}`, { folderId: null })).status).toBe(400);
    expect((await req("PATCH", `/api/projects/${a.id}`, { name: "A" })).status).toBe(200);
  });

  it("PUT /api/projects/order ignores folder ids (older clients) but needs every project", async () => {
    const a = addProject("a");
    const b = addProject("b");
    const work = env.service.createFolder({ name: "Work" });
    const res = await req<Project[]>("PUT", "/api/projects/order", { ids: [a.id, work.id, b.id] });
    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.id)).toEqual([a.id, b.id]);
    expect((await req("PUT", "/api/projects/order", { ids: [a.id, work.id] })).status).toBe(400);
    expect((await req("PUT", "/api/projects/order", { ids: [a.id, b.id, "nope"] })).status).toBe(400);
  });

  it("moves chats in (to the folder's top) and out (right after the folder) within their list only", async () => {
    const a = addProject("a");
    const b = addProject("b");
    const top = env.service.createFolder({ name: "Top" });
    const inA = env.service.createFolder({ name: "A", projectId: a.id });
    const inB = env.service.createFolder({ name: "B", projectId: b.id });
    const s1 = await chat("s1");
    const s2 = await chat("s2");
    const a1 = await chat("a1", a.id);
    const a2 = await chat("a2", a.id);
    const a3 = await chat("a3", a.id);
    expect(list(a.id)).toEqual(["a3", "a2", "a1", "[A]"]);

    const moved = await req<WorkspaceSummary>("PATCH", `/api/workspaces/${s1}`, { folderId: top.id });
    expect(moved.status).toBe(200);
    expect(moved.body.folderId).toBe(top.id);
    await req("PATCH", `/api/workspaces/${s2}`, { folderId: top.id });
    expect(list(null)).toEqual(["[Top]", "  s2", "  s1"]);

    await req("PATCH", `/api/workspaces/${a1}`, { folderId: inA.id });
    await req("PATCH", `/api/workspaces/${a3}`, { folderId: inA.id });
    expect(list(a.id)).toEqual(["a2", "[A]", "  a3", "  a1"]);
    // Out: right after the folder.
    expect((await req<WorkspaceSummary>("PATCH", `/api/workspaces/${a3}`, { folderId: null })).body.folderId).toBeNull();
    expect(list(a.id)).toEqual(["a2", "[A]", "  a1", "a3"]);

    expect((await req("PATCH", `/api/workspaces/${s1}`, { folderId: inA.id })).status).toBe(400);
    expect((await req("PATCH", `/api/workspaces/${a1}`, { folderId: inB.id })).status).toBe(400);
    expect((await req("PATCH", `/api/workspaces/${a1}`, { folderId: top.id })).status).toBe(400);
    expect((await req("PATCH", `/api/workspaces/${a1}`, { folderId: "nope" })).status).toBe(404);
  });

  it("creates a chat inside a folder (I-215): at the folder's top, in its own list only", async () => {
    const a = addProject("a");
    const b = addProject("b");
    const top = env.service.createFolder({ name: "Top" });
    const inA = env.service.createFolder({ name: "A", projectId: a.id });
    const inB = env.service.createFolder({ name: "B", projectId: b.id });
    const create = (body: Record<string, unknown>) => req<{ workspace: WorkspaceSummary }>("POST", "/api/workspaces", body);
    const s1 = await chat("s1");
    await req("PATCH", `/api/workspaces/${s1}`, { folderId: top.id });

    const made = await create({ projectId: null, folderId: top.id });
    expect(made.status).toBe(200);
    expect(made.body.workspace.folderId).toBe(top.id);
    await req("PATCH", `/api/workspaces/${made.body.workspace.id}`, { title: "s2" });
    expect(list(null)).toEqual(["[Top]", "  s2", "  s1"]);

    const inProject = await create({ projectId: a.id, folderId: inA.id });
    expect(inProject.body.workspace.folderId).toBe(inA.id);
    expect(list(a.id)).toEqual(["[A]", `  ${inProject.body.workspace.title}`]);

    // Without a folder (or null) it still goes to the top of the list, outside folders.
    expect((await create({ projectId: null, folderId: null })).body.workspace.folderId ?? null).toBeNull();

    const before = env.service.listWorkspaces().length;
    expect((await create({ projectId: null, folderId: inA.id })).status).toBe(400);
    expect((await create({ projectId: a.id, folderId: top.id })).status).toBe(400);
    expect((await create({ projectId: a.id, folderId: inB.id })).status).toBe(400);
    expect((await create({ projectId: null, folderId: "nope" })).status).toBe(400);
    expect((await create({ projectId: null, folderId: 5 })).status).toBe(400);
    expect(env.service.listWorkspaces()).toHaveLength(before);
  });

  it("unpinning puts a chat at the top of its container, below the pinned ones", async () => {
    const a = addProject("a");
    const x = await chat("x", a.id);
    await chat("y", a.id);
    const z = await chat("z", a.id);
    await env.service.updateWorkspace(z, { pinned: true });
    await env.service.updateWorkspace(x, { pinned: true });
    expect(list(a.id)).toEqual(["x", "z", "y"]);
    await env.service.updateWorkspace(x, { pinned: false });
    expect(list(a.id)).toEqual(["z", "x", "y"]);
  });

  it("deleting a folder puts its chats in its place; nothing else is deleted", async () => {
    const a = addProject("a");
    const a1 = await chat("a1", a.id);
    const f = env.service.createFolder({ name: "F", projectId: a.id });
    const a2 = await chat("a2", a.id);
    const a3 = await chat("a3", a.id);
    await env.service.updateWorkspace(a1, { folderId: f.id });
    await env.service.updateWorkspace(a3, { folderId: f.id });
    expect(list(a.id)).toEqual(["a2", "[F]", "  a3", "  a1"]);
    env.messages.length = 0;

    expect((await req("DELETE", `/api/folders/${f.id}`)).status).toBe(204);
    expect(list(a.id)).toEqual(["a2", "a3", "a1"]);
    expect(env.service.listWorkspaces().filter((w) => w.projectId === a.id)).toHaveLength(3);
    const types = env.messages.map((m) => m.type);
    expect(types).toContain("folder_removed");
    expect(types).toContain("workspace_upsert");
    expect((await req("DELETE", `/api/folders/${f.id}`)).status).toBe(404);
    void a2;
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

describe("PUT /api/workspaces/order (I-202)", () => {
  it("rewrites a project's top level: chats and folders mixed", async () => {
    const a = addProject("a");
    const a1 = await chat("a1", a.id);
    const f = env.service.createFolder({ name: "F", projectId: a.id });
    const a2 = await chat("a2", a.id);
    expect(list(a.id)).toEqual(["a2", "[F]", "a1"]);
    env.messages.length = 0;

    const res = await req<ReorderChatListResponse>("PUT", "/api/workspaces/order", { projectId: a.id, folderId: null, ids: [a1, a2, f.id] });
    expect(res.status).toBe(200);
    expect(list(a.id)).toEqual(["a1", "a2", "[F]"]);
    expect(res.body.workspaces.map((w) => w.id)).toEqual([a1, a2]);
    expect(res.body.folders.map((x) => [x.id, x.sortOrder])).toEqual([[f.id, 2]]);
    // Only what changed is pushed (a1 already had 0).
    const pushed = env.messages.flatMap((m) => (m.type === "workspace_upsert" ? [m.workspace.id] : m.type === "folder_upsert" ? [m.folder.id] : []));
    expect(new Set(pushed)).toEqual(new Set([a2, f.id]));
  });

  it("moves chats into a folder at a position, out of it, and reorders inside it", async () => {
    const a = addProject("a");
    const a1 = await chat("a1", a.id);
    const a2 = await chat("a2", a.id);
    const f = env.service.createFolder({ name: "F", projectId: a.id });
    const a3 = await chat("a3", a.id);
    await env.service.updateWorkspace(a1, { folderId: f.id });
    expect(list(a.id)).toEqual(["a3", "[F]", "  a1", "a2"]);

    // a3 into the folder, below a1.
    expect((await req("PUT", "/api/workspaces/order", { projectId: a.id, folderId: f.id, ids: [a1, a3] })).status).toBe(200);
    expect(list(a.id)).toEqual(["[F]", "  a1", "  a3", "a2"]);
    // Reorder inside it.
    await req("PUT", "/api/workspaces/order", { projectId: a.id, folderId: f.id, ids: [a3, a1] });
    expect(list(a.id)).toEqual(["[F]", "  a3", "  a1", "a2"]);
    // a1 out of it, to the very top.
    await req("PUT", "/api/workspaces/order", { projectId: a.id, folderId: null, ids: [a1, f.id, a2] });
    expect(list(a.id)).toEqual(["a1", "[F]", "  a3", "a2"]);
    expect(env.store.getWorkspace(a1)?.folderId).toBeNull();
  });

  it("works the same in the Chats section; pinned chats don't need listing", async () => {
    const s1 = await chat("s1");
    const s2 = await chat("s2");
    const s3 = await chat("s3");
    const f = env.service.createFolder({ name: "F" });
    await env.service.updateWorkspace(s3, { pinned: true });
    expect(list(null)).toEqual(["s3", "[F]", "s2", "s1"]);
    expect((await req("PUT", "/api/workspaces/order", { projectId: null, folderId: null, ids: [s1, f.id, s2] })).status).toBe(200);
    expect(list(null)).toEqual(["s3", "s1", "[F]", "s2"]);
    // A pinned chat may be moved into a folder this way too (it stays pinned, on top there).
    await req("PUT", "/api/workspaces/order", { projectId: null, folderId: f.id, ids: [s2, s3] });
    expect(list(null)).toEqual(["s1", "[F]", "  s3", "  s2"]);
  });

  it("refuses moves out of the list, nesting folders, and incomplete or repeated lists", async () => {
    const a = addProject("a");
    const b = addProject("b");
    const a1 = await chat("a1", a.id);
    const a2 = await chat("a2", a.id);
    const b1 = await chat("b1", b.id);
    const s1 = await chat("s1");
    const fa = env.service.createFolder({ name: "FA", projectId: a.id });
    const fa2 = env.service.createFolder({ name: "FA2", projectId: a.id });
    const fb = env.service.createFolder({ name: "FB", projectId: b.id });
    const put = (body: unknown) => req("PUT", "/api/workspaces/order", body).then((r) => r.status);
    const top = [a1, a2, fa.id, fa2.id];
    expect(await put({ projectId: a.id, folderId: null, ids: [...top, b1] })).toBe(400); // another project's chat
    expect(await put({ projectId: a.id, folderId: null, ids: [...top, s1] })).toBe(400); // a standalone chat
    expect(await put({ projectId: a.id, folderId: null, ids: [...top, fb.id] })).toBe(400); // another project's folder
    expect(await put({ projectId: a.id, folderId: fa.id, ids: [fa2.id] })).toBe(400); // folder in a folder
    expect(await put({ projectId: a.id, folderId: fb.id, ids: [a1] })).toBe(400); // folder of another list
    expect(await put({ projectId: a.id, folderId: null, ids: [a1, fa.id, fa2.id] })).toBe(400); // a2 missing
    expect(await put({ projectId: a.id, folderId: null, ids: [...top, a1] })).toBe(400); // repeated
    expect(await put({ projectId: a.id, folderId: null, ids: [...top, "nope"] })).toBe(404);
    expect(await put({ projectId: "nope", folderId: null, ids: [] })).toBe(404);
    expect(await put({ projectId: a.id, folderId: 3, ids: top })).toBe(400);
    expect(await put({ projectId: a.id, folderId: null, ids: top })).toBe(200);
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
      expect(schemaVersion(upgraded)).toBeGreaterThanOrEqual(7);
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'folders'").get()).toBeTruthy();
      upgraded.close();

      const folder = env.service.createFolder({ name: "Work" });
      const { wid } = await newChat(env);
      await env.service.updateWorkspace(wid, { folderId: folder.id });
      const reopened = new Store(env.store.dataDir, 0);
      expect(reopened.listFolders()).toEqual([env.store.getFolder(folder.id)]);
      expect(reopened.getWorkspace(wid)?.folderId).toBe(folder.id);
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
