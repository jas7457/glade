/**
 * I-165: grouping into folders (top level, memberships) and where a drag in the project list lands.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Folder } from "@glade/protocol";
import { makeProject, makeWorkspace } from "@glade/app-core/test/fixtures";
import { buildTopLevel, entryId, flatOrder, flattenProjects, resolveTreeDrop, workspaceFolderId, type TreeRow } from "./folders";
import * as store from "./store";
import { resetClientOrders } from "./env-order";

const folder = (over: Partial<Folder> & { id: string }): Folder => ({ name: over.id, projectId: null, sortOrder: 0, createdAt: 0, ...over });
const envOf = (item: { environmentId?: string }) => item.environmentId ?? "L";

describe("buildTopLevel", () => {
  it("mixes projects and top-level folders by sortOrder; folders hold their projects", () => {
    const projects = [
      makeProject({ id: "a", sortOrder: 0 }),
      makeProject({ id: "b", sortOrder: 3, folderId: "f" }),
      makeProject({ id: "c", sortOrder: 2, folderId: "f" }),
      makeProject({ id: "d", sortOrder: 4 }),
    ];
    const entries = buildTopLevel(projects, [folder({ id: "f", sortOrder: 1 }), folder({ id: "inner", projectId: "a" })], [], ["L"], envOf);
    expect(entries.map(entryId)).toEqual(["a", "f", "d"]);
    expect(entries[1]?.kind === "folder" && entries[1].projects.map((p) => p.id)).toEqual(["c", "b"]);
    expect(flattenProjects(entries).map((p) => p.id)).toEqual(["a", "c", "b", "d"]);
    expect(flatOrder(entries)).toEqual(["a", "f", "c", "b", "d"]);
  });

  it("shows projects of a missing folder, or another environment's folder, at the top level", () => {
    const projects = [makeProject({ id: "a", folderId: "gone" }), makeProject({ id: "b", folderId: "f", environmentId: "R" })];
    const entries = buildTopLevel(projects, [folder({ id: "f" })], [], ["L", "R"], envOf);
    expect(entries.map(entryId).sort()).toEqual(["a", "b", "f"]);
  });

  it("interleaves environments by the device's slots", () => {
    const entries = buildTopLevel([makeProject({ id: "a" }), makeProject({ id: "r", environmentId: "R" })], [folder({ id: "f", sortOrder: -1 })], ["R:r", "L:f", "L:a"], ["L", "R"], envOf);
    expect(entries.map(entryId)).toEqual(["r", "f", "a"]);
  });
});

describe("workspaceFolderId", () => {
  const folders = new Map([
    ["top", folder({ id: "top" })],
    ["pf", folder({ id: "pf", projectId: "p" })],
  ]);
  it("takes top-level folders for standalone chats and the chat's project's folders otherwise", () => {
    expect(workspaceFolderId(makeWorkspace({ id: "1", projectId: null, folderId: "top" }), folders, envOf)).toBe("top");
    expect(workspaceFolderId(makeWorkspace({ id: "2", projectId: "p", folderId: "pf" }), folders, envOf)).toBe("pf");
    expect(workspaceFolderId(makeWorkspace({ id: "3", projectId: "p", folderId: "top" }), folders, envOf)).toBeNull();
    expect(workspaceFolderId(makeWorkspace({ id: "4", projectId: "q", folderId: "pf" }), folders, envOf)).toBeNull();
    expect(workspaceFolderId(makeWorkspace({ id: "5", projectId: null, folderId: "gone" }), folders, envOf)).toBeNull();
  });
});

describe("resolveTreeDrop", () => {
  // a, [F: b, c], d
  const rows: TreeRow[] = [
    { id: "a", kind: "project", parent: null },
    { id: "F", kind: "folder", parent: null },
    { id: "b", kind: "project", parent: "F" },
    { id: "c", kind: "project", parent: "F" },
    { id: "d", kind: "project", parent: null },
  ];
  const open = new Set(["F"]);

  it("right below an open folder's row: into the folder", () => {
    expect(resolveTreeDrop(rows, ["F", "a", "b", "c", "d"], "a", open)).toEqual({ top: ["F", "d"], inside: { F: ["a", "b", "c"] }, moved: { id: "a", folderId: "F" } });
  });

  it("between two of its projects: into the folder", () => {
    expect(resolveTreeDrop(rows, ["a", "F", "b", "d", "c"], "d", open).moved).toEqual({ id: "d", folderId: "F" });
  });

  it("below its last project: out, unless it came from that folder", () => {
    expect(resolveTreeDrop(rows, ["F", "b", "c", "a", "d"], "a", open)).toEqual({ top: ["F", "a", "d"], inside: { F: ["b", "c"] } });
    expect(resolveTreeDrop(rows, ["a", "F", "c", "b", "d"], "b", open)).toEqual({ top: ["a", "F", "d"], inside: { F: ["c", "b"] } });
  });

  it("a project dragged out to the top level leaves the folder", () => {
    expect(resolveTreeDrop(rows, ["b", "a", "F", "c", "d"], "b", open)).toEqual({ top: ["b", "a", "F", "d"], inside: { F: ["c"] }, moved: { id: "b", folderId: null } });
  });

  it("after a closed folder's row: stays at the top level", () => {
    const closedRows = rows.filter((r) => r.parent === null);
    expect(resolveTreeDrop(closedRows, ["F", "a", "d"], "a", new Set()).moved).toBeUndefined();
  });

  it("a folder takes its projects along and never lands inside another folder's block", () => {
    expect(resolveTreeDrop(rows, ["a", "b", "c", "d", "F"], "F", open)).toEqual({ top: ["a", "d", "F"], inside: { F: ["b", "c"] } });
    const two: TreeRow[] = [...rows, { id: "G", kind: "folder", parent: null }];
    // Dropped between F's projects: goes after them.
    expect(resolveTreeDrop(two, ["a", "F", "b", "G", "c", "d"], "G", open).top).toEqual(["a", "F", "G", "d"]);
  });
});

describe("store: folders (I-165)", () => {
  beforeEach(() => {
    resetClientOrders();
    store.projects.value = [makeProject({ id: "p", sortOrder: 1 }), makeProject({ id: "q", sortOrder: 2, folderId: "top" })];
    store.folders.value = [folder({ id: "top", sortOrder: 0 }), folder({ id: "pf", projectId: "p" })];
    store.workspaces.value = [
      makeWorkspace({ id: "w1", projectId: "p", folderId: "pf" }),
      makeWorkspace({ id: "w2", projectId: "p" }),
      makeWorkspace({ id: "w3", projectId: null, folderId: "top" }),
      makeWorkspace({ id: "w4", projectId: null }),
    ];
  });

  it("groups projects and chats", () => {
    expect(store.sidebarEntries.value.map(entryId)).toEqual(["top", "p"]);
    expect(store.sortedProjects.value.map((p) => p.id)).toEqual(["q", "p"]);
    expect(store.looseWorkspaces("p").map((w) => w.id)).toEqual(["w2"]);
    expect(store.workspacesInFolder("pf").map((w) => w.id)).toEqual(["w1"]);
    expect(store.workspacesInFolder("top").map((w) => w.id)).toEqual(["w3"]);
    expect(store.looseWorkspaces(null).map((w) => w.id)).toEqual(["w4"]);
    expect(store.foldersForProject("p").map((f) => f.id)).toEqual(["pf"]);
  });

  it("applies folder pushes, snapshots and checks", () => {
    store.handleServerMessage({ type: "folder_upsert", folder: folder({ id: "new", name: "New" }) });
    expect(store.folders.value.map((f) => f.id)).toContain("new");
    store.handleServerMessage({ type: "folder_removed", folderId: "pf" });
    expect(store.looseWorkspaces("p").map((w) => w.id).sort()).toEqual(["w1", "w2"]);
    expect(store.applyShellCheck({ projects: ["p", "q"], workspaces: ["w1", "w2", "w3", "w4"], sessions: [], folders: ["top"] })).toBe(false);
    expect(store.folders.value.map((f) => f.id)).toEqual(["top"]);
    // A folder the client doesn't have: take a snapshot.
    expect(store.applyShellCheck({ projects: ["p", "q"], workspaces: ["w1", "w2", "w3", "w4"], sessions: [], folders: ["top", "other"] })).toBe(true);
    store.applyShellSnapshot({ projects: [], workspaces: [], sessions: [], settings: store.settings.value, folders: [folder({ id: "s" })] });
    expect(store.folders.value.map((f) => f.id)).toEqual(["s"]);
    store.resetShellSync();
  });
});
