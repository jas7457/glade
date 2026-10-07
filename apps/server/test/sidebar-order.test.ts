/**
 * I-202: the one-time sidebar order migration (`migrate-sidebar-order.ts`): today's visual order
 * becomes the manual order, projects leave folders, project-less folders join the Chats section.
 * Pure function first, then the store running it once per data folder.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Folder, Project, Workspace } from "@glade/protocol";
import { getMeta } from "../src/store/db/database.js";
import { migrateSidebarOrder, SIDEBAR_ORDER_META_KEY } from "../src/store/migrate-sidebar-order.js";
import { Store } from "../src/store/store.js";

const project = (id: string, sortOrder: number, folderId?: string): Project & { folderId?: string } => ({
  id,
  name: id,
  path: `/${id}`,
  sortOrder,
  createdAt: 1,
  lastActivityAt: 1,
  ...(folderId ? { folderId } : {}),
});
const chat = (id: string, projectId: string | null, createdAt: number, extra: Partial<Workspace> = {}): Workspace => ({
  id,
  projectId,
  title: id,
  titleSource: "auto",
  cwd: "/",
  pinned: false,
  createdAt,
  lastActivityAt: createdAt,
  layout: null,
  ...extra,
});
const folder = (id: string, projectId: string | null, sortOrder: number): Folder => ({ id, name: id, projectId, sortOrder, createdAt: 1 });

describe("migrateSidebarOrder", () => {
  it("a list's top level: pinned (pinOrder), then folders, then the other chats newest first", () => {
    const folders = [folder("F2", "p", 5), folder("F1", "p", 1)];
    const changes = migrateSidebarOrder({
      projects: [project("p", 0)],
      folders,
      workspaces: [
        chat("old", "p", 1),
        chat("new", "p", 9),
        chat("pinB", "p", 3, { pinned: true, pinOrder: 1 }),
        chat("pinA", "p", 2, { pinned: true, pinOrder: 0 }),
        chat("in1", "p", 4, { folderId: "F1" }),
        chat("in2", "p", 8, { folderId: "F1" }),
        chat("inPinned", "p", 1, { folderId: "F1", pinned: true, pinOrder: 2 }),
        chat("stale", "p", 5, { folderId: "gone" }),
      ],
    });
    const order = new Map<string, number>([...changes.workspaces, ...changes.folders].map((x) => [x.id, x.sortOrder!]));
    const top = ["pinA", "pinB", "F1", "F2", "new", "stale", "old"];
    expect(top.map((id) => order.get(id))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(["inPinned", "in2", "in1"].map((id) => order.get(id))).toEqual([0, 1, 2]);
    expect(changes.projects).toEqual([]);
  });

  it("standalone chats and project-less folders form the Chats section the same way", () => {
    const changes = migrateSidebarOrder({
      projects: [],
      folders: [folder("Top", null, 0)],
      workspaces: [chat("s1", null, 1), chat("s2", null, 2), chat("s3", null, 3, { folderId: "Top" })],
    });
    const order = new Map<string, number>([...changes.workspaces, ...changes.folders].map((x) => [x.id, x.sortOrder!]));
    expect(order.get("Top") ?? 0).toBe(0);
    expect(order.get("s2")).toBe(1);
    expect(order.get("s1")).toBe(2);
    expect(order.get("s3")).toBe(0);
  });

  it("projects leave folders, renumbered in the order they were shown", () => {
    const changes = migrateSidebarOrder({
      // Shown as: a, [Work: c, b], d
      projects: [project("a", 0), project("b", 3, "W"), project("c", 2, "W"), project("d", 5)],
      folders: [folder("W", null, 1)],
      workspaces: [],
    });
    const byId = new Map(changes.projects.map((p) => [p.id, p]));
    expect(["a", "c", "b", "d"].map((id) => byId.get(id)?.sortOrder ?? 0)).toEqual([0, 1, 2, 3]);
    expect(changes.projects.every((p) => !("folderId" in p))).toBe(true);
  });

  it("without folders, projects keep their order; a stray folderId is still dropped", () => {
    const changes = migrateSidebarOrder({ projects: [project("a", 7), { ...project("b", 9), folderId: null } as Project], folders: [], workspaces: [] });
    expect(changes.projects).toEqual([project("b", 9)]);
  });
});

describe("store runs it once (I-202)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("migrates on first open, records it, and leaves later data alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-sidebar-order-"));
    dirs.push(dir);
    const first = new Store(dir, 0);
    // Pretend this is data from before I-202 (as an older server wrote it).
    first.db.prepare("DELETE FROM meta WHERE key = ?").run(SIDEBAR_ORDER_META_KEY);
    first.saveSidebar({
      projects: [project("p", 0, "W") as Project],
      folders: [folder("W", null, 1)],
      workspaces: [chat("old", "p", 1), chat("new", "p", 2)],
    });
    first.dispose();

    const store = new Store(dir, 0);
    expect(getMeta(store.db, SIDEBAR_ORDER_META_KEY)).not.toBeNull();
    expect(store.getProject("p")).not.toHaveProperty("folderId");
    expect(store.getWorkspace("new")?.sortOrder).toBe(0);
    expect(store.getWorkspace("old")?.sortOrder).toBe(1);
    // Other servers see the change as events.
    const types = (store.db.prepare("SELECT type, entity_id FROM events ORDER BY seq DESC LIMIT 3").all() as Array<{ type: string }>).map((r) => r.type);
    expect(types.length).toBeGreaterThan(0);

    // A later chat without sortOrder (an older server) isn't renumbered on the next open.
    store.upsertWorkspace(chat("later", "p", 3));
    store.dispose();
    const again = new Store(dir, 0);
    expect(again.getWorkspace("later")).not.toHaveProperty("sortOrder");
    expect(again.getWorkspace("old")?.sortOrder).toBe(1);
    again.dispose();
  });
});
