/**
 * I-019: manual project order, pinned-chat order, and the migration from pinned projects.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project, WorkspaceSummary } from "@glade/protocol";
import type { LegacyChat } from "../src/store/migrate-workspaces.js";
import { createApp } from "../src/http/app.js";
import { Store } from "../src/store/store.js";
import { createTestEnv, flush, newChat, type TestEnv } from "./helpers.js";

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

function req(method: string, path: string, body?: unknown) {
  const { app } = createApp({ service: env.service });
  return app.request(path, {
    method,
    headers: { host: "127.0.0.1:4317", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("project order", () => {
  it("new projects go to the top", () => {
    const a = addProject("a");
    const b = addProject("b");
    const c = addProject("c");
    expect(env.service.listProjects().map((p) => p.id)).toEqual([c.id, b.id, a.id]);
  });

  it("activity never reorders projects", async () => {
    const a = addProject("a");
    const b = addProject("b");
    const chat = await newChat(env, { projectId: a.id, prompt: "hi" });
    await flush();
    await env.service.prompt(chat.sid, { text: "again" });
    await flush();
    expect(env.service.listProjects().map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("PUT /api/projects/order rewrites sortOrder and broadcasts only changes", async () => {
    const a = addProject("a");
    const b = addProject("b");
    const c = addProject("c");
    env.messages.length = 0;
    const res = await req("PUT", "/api/projects/order", { ids: [a.id, c.id, b.id] });
    expect(res.status).toBe(200);
    const projects = (await res.json()) as Project[];
    expect(projects.map((p) => [p.id, p.sortOrder])).toEqual([
      [a.id, 0],
      [c.id, 1],
      [b.id, 2],
    ]);
    // a was already at 0: only c and b changed.
    expect(env.messages.filter((m) => m.type === "project_upsert").map((m) => m.type === "project_upsert" && m.project.id)).toEqual([
      c.id,
      b.id,
    ]);
    expect((await (await req("GET", "/api/projects")).json()) as Project[]).toEqual(projects);

    env.messages.length = 0;
    await req("PUT", "/api/projects/order", { ids: [a.id, b.id, c.id] });
    expect(env.messages.filter((m) => m.type === "project_upsert").map((m) => m.type === "project_upsert" && m.project.id)).toEqual([
      b.id,
      c.id,
    ]);
    // A new project still lands on top afterwards.
    const d = addProject("d");
    expect(env.service.listProjects()[0]).toMatchObject({ id: d.id, sortOrder: -1 });
  });

  it("rejects ids that aren't exactly the set of projects", async () => {
    const a = addProject("a");
    const b = addProject("b");
    for (const ids of [[a.id], [a.id, b.id, "x"], [a.id, a.id], [a.id, "x"]]) {
      expect((await req("PUT", "/api/projects/order", { ids })).status).toBe(400);
    }
    expect((await req("PUT", "/api/projects/order", { ids: "nope" })).status).toBe(400);
    expect((await req("PUT", "/api/projects/order", {})).status).toBe(400);
  });

  it("PATCH no longer pins projects", async () => {
    const a = addProject("a");
    const res = await req("PATCH", `/api/projects/${a.id}`, { pinned: true, name: "Renamed" });
    expect(await res.json()).toEqual({ ...a, name: "Renamed" });
  });
});

describe("pinned workspace order", () => {
  async function chats(projectId: string | null, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await newChat(env, { projectId })).wid);
    return ids;
  }
  const pinOrder = (id: string) => env.store.getWorkspace(id)?.pinOrder;

  it("pinning goes to the top of that list's pinned group; unpinning clears pinOrder", async () => {
    const p = addProject("p");
    const [x, y, z] = await chats(p.id, 3);
    const [s] = await chats(null, 1);
    await env.service.updateWorkspace(x!, { pinned: true });
    await env.service.updateWorkspace(y!, { pinned: true });
    await env.service.updateWorkspace(s!, { pinned: true }); // other list: independent
    expect([pinOrder(x!), pinOrder(y!), pinOrder(s!)]).toEqual([0, -1, 0]);
    await env.service.updateWorkspace(y!, { pinned: true }); // already pinned: unchanged
    expect(pinOrder(y!)).toBe(-1);

    const unpinned = await env.service.updateWorkspace(y!, { pinned: false });
    expect(unpinned.pinned).toBe(false);
    expect(unpinned).not.toHaveProperty("pinOrder");
    expect(pinOrder(z!)).toBeUndefined();
  });

  it("PUT /api/workspaces/pin-order reorders one list and validates the set", async () => {
    const p = addProject("p");
    const [x, y, z] = await chats(p.id, 3);
    const [s] = await chats(null, 1);
    for (const id of [x!, y!, s!]) await env.service.updateWorkspace(id, { pinned: true });
    env.messages.length = 0;

    const res = await req("PUT", "/api/workspaces/pin-order", { projectId: p.id, ids: [x, y] });
    expect(res.status).toBe(200);
    const summaries = (await res.json()) as WorkspaceSummary[];
    expect(summaries.map((c) => [c.id, c.pinOrder])).toEqual([
      [x, 0],
      [y, 1],
    ]);
    // x was already at 0; only y moved.
    expect(env.messages.filter((m) => m.type === "workspace_upsert").map((m) => m.type === "workspace_upsert" && m.workspace.id)).toEqual([y]);

    const bad = [
      { projectId: p.id, ids: [x] }, // missing y
      { projectId: p.id, ids: [x, y, z] }, // z isn't pinned
      { projectId: p.id, ids: [x, s] }, // s is in another list
      { projectId: null, ids: [x] },
      { projectId: 5, ids: [] },
      { projectId: p.id },
    ];
    for (const body of bad) expect((await req("PUT", "/api/workspaces/pin-order", body)).status).toBe(400);
    expect((await req("PUT", "/api/workspaces/pin-order", { projectId: "missing", ids: [] })).status).toBe(404);
    expect((await req("PUT", "/api/workspaces/pin-order", { projectId: null, ids: [s] })).status).toBe(200);
  });
});

describe("store migration", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("gives old projects a sortOrder from their previous order and drops pinned", () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-migrate-"));
    dirs.push(dir);
    const old = (id: string, pinned: boolean, lastActivityAt: number) => ({ id, name: id, path: `/${id}`, pinned, createdAt: 1, lastActivityAt });
    writeFileSync(
      join(dir, "projects.json"),
      JSON.stringify({ version: 1, projects: [old("quiet", false, 1), old("busy", false, 9), old("pinned", true, 0)] }),
    );
    const chat = (id: string, projectId: string | null, pinned: boolean, lastActivityAt: number, pinOrder?: number): LegacyChat => ({
      id,
      projectId,
      title: id,
      titleSource: "auto",
      cwd: "/",
      harness: "fake",
      sessionRef: null,
      pinned,
      unread: false,
      createdAt: 1,
      lastActivityAt,
      model: null,
      thinkingLevel: null,
      ...(pinOrder !== undefined ? { pinOrder } : {}),
    });
    writeFileSync(
      join(dir, "chats.json"),
      JSON.stringify({
        version: 1,
        chats: [chat("old", "busy", true, 1), chat("new", "busy", true, 5), chat("solo", null, true, 1), chat("stray", null, false, 1, 4)],
      }),
    );

    const store = new Store(dir, 0);
    const order = [...store.listProjects()].sort((a, b) => a.sortOrder - b.sortOrder);
    expect(order.map((p) => [p.id, p.sortOrder])).toEqual([
      ["pinned", 0],
      ["busy", 1],
      ["quiet", 2],
    ]);
    const onDisk = JSON.parse(readFileSync(join(dir, "projects.json"), "utf8")) as { projects: object[] };
    expect(onDisk.projects.every((p) => !("pinned" in p))).toBe(true);
    expect(store.getWorkspace("new")?.pinOrder).toBe(0);
    expect(store.getWorkspace("old")?.pinOrder).toBe(1);
    expect(store.getWorkspace("solo")?.pinOrder).toBe(0);
    expect(store.getWorkspace("stray")).not.toHaveProperty("pinOrder");
  });
});
