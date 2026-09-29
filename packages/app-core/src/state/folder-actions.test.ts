/**
 * I-165: folder actions against a mocked API: create / rename / delete, moving in and out,
 * reordering the project list with folders, and applying a drop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder } from "@glade/protocol";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    createFolder: vi.fn(),
    updateFolder: vi.fn(),
    deleteFolder: vi.fn(),
    reorderFolders: vi.fn(),
    updateProject: vi.fn(),
    updateWorkspace: vi.fn(),
    reorderProjects: vi.fn(),
    reorderPinnedWorkspaces: vi.fn(),
  },
}));

import { api } from "@glade/app-core/lib/api";
import { makeProject, makeWorkspace } from "@glade/app-core/test/fixtures";
import { folders, looseWorkspaces, projects, sidebarEntries, workspaces, workspacesInFolder } from "./store";
import { movePinnedWorkspace, moveProject, reorderProjects } from "./actions";
import { applyProjectDrop, createFolder, deleteFolder, moveProjectToFolder, moveWorkspaceToFolder, renameFolder, reorderProjectFolders } from "./folder-actions";
import { entryId } from "./folders";
import { resetClientOrders } from "./env-order";
import { toasts } from "./toasts";

const mocked = vi.mocked(api);
const folder = (over: Partial<Folder> & { id: string }): Folder => ({ name: over.id, projectId: null, sortOrder: 0, createdAt: 0, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  resetClientOrders();
  toasts.value = [];
  // a, [F: b, c], d
  projects.value = [
    makeProject({ id: "a", sortOrder: 0 }),
    makeProject({ id: "b", sortOrder: 2, folderId: "F" }),
    makeProject({ id: "c", sortOrder: 3, folderId: "F" }),
    makeProject({ id: "d", sortOrder: 4 }),
  ];
  folders.value = [folder({ id: "F", sortOrder: 1 })];
  workspaces.value = [];
  mocked.reorderProjects.mockResolvedValue([]);
});

describe("folder actions (I-165)", () => {
  it("creates, renames and deletes folders", async () => {
    mocked.createFolder.mockResolvedValue(folder({ id: "N", name: "New Folder", projectId: "a" }));
    expect((await createFolder("New Folder", { projectId: "a" }))?.id).toBe("N");
    expect(mocked.createFolder).toHaveBeenCalledWith({ name: "New Folder", projectId: "a" });
    expect(folders.value.map((f) => f.id)).toContain("N");

    mocked.updateFolder.mockResolvedValue(folder({ id: "N", name: "Bugs", projectId: "a" }));
    expect(await renameFolder("N", "Bugs")).toBe(true);
    expect(folders.value.find((f) => f.id === "N")?.name).toBe("Bugs");

    mocked.updateFolder.mockRejectedValue(new Error("offline"));
    expect(await renameFolder("N", "Nope")).toBe(false);
    expect(folders.value.find((f) => f.id === "N")?.name).toBe("Bugs");
    expect(toasts.value[0]?.message).toContain("offline");

    mocked.deleteFolder.mockResolvedValue(undefined);
    expect(await deleteFolder("N")).toBe(true);
    expect(folders.value.map((f) => f.id)).toEqual(["F"]);
  });

  it("moves chats and projects in and out (optimistic, rolled back on failure)", async () => {
    workspaces.value = [makeWorkspace({ id: "w", projectId: null })];
    mocked.updateWorkspace.mockImplementation(async (id, patch) => ({ ...workspaces.value.find((w) => w.id === id)!, ...patch }));
    expect(await moveWorkspaceToFolder("w", "F")).toBe(true);
    expect(mocked.updateWorkspace).toHaveBeenCalledWith("w", { folderId: "F" });
    expect(workspacesInFolder("F").map((w) => w.id)).toEqual(["w"]);

    mocked.updateWorkspace.mockRejectedValue(new Error("nope"));
    expect(await moveWorkspaceToFolder("w", null)).toBe(false);
    expect(workspacesInFolder("F").map((w) => w.id)).toEqual(["w"]);
    expect(looseWorkspaces(null)).toEqual([]);

    mocked.updateProject.mockImplementation(async (id, patch) => ({ ...projects.value.find((p) => p.id === id)!, ...patch }));
    expect(await moveProjectToFolder("a", "F")).toBe(true);
    expect(mocked.updateProject).toHaveBeenCalledWith("a", { folderId: "F" });
    expect(sidebarEntries.value.map(entryId)).toEqual(["F", "d"]);
  });

  it("reordering the top level sends folders with their projects in place", async () => {
    await reorderProjects(["d", "F", "a"]);
    expect(mocked.reorderProjects).toHaveBeenCalledWith(["d", "F", "b", "c", "a"]);
    expect(sidebarEntries.value.map(entryId)).toEqual(["d", "F", "a"]);
    await reorderProjects(["d", "F", "a"], { F: ["c", "b"] });
    expect(mocked.reorderProjects).toHaveBeenLastCalledWith(["d", "F", "c", "b", "a"]);
  });

  it("Move Up / Down steps within the project's own list", async () => {
    await moveProject("c", -1);
    expect(mocked.reorderProjects).toHaveBeenLastCalledWith(["a", "F", "c", "b", "d"]);
    await moveProject("F", 1);
    expect(mocked.reorderProjects).toHaveBeenLastCalledWith(["a", "d", "F", "c", "b"]);
  });

  it("a drop moves the project first, then sends the exact order", async () => {
    mocked.updateProject.mockImplementation(async (id, patch) => ({ ...projects.value.find((p) => p.id === id)!, ...patch }));
    expect(await applyProjectDrop({ top: ["F", "d"], inside: { F: ["b", "a", "c"] }, moved: { id: "a", folderId: "F" } })).toBe(true);
    expect(mocked.updateProject).toHaveBeenCalledWith("a", { folderId: "F" });
    expect(mocked.reorderProjects).toHaveBeenLastCalledWith(["F", "b", "a", "c", "d"]);
  });

  it("reorders a project's folders", async () => {
    folders.value = [...folders.value, folder({ id: "x", projectId: "a", sortOrder: 0 }), folder({ id: "y", projectId: "a", sortOrder: 1 })];
    mocked.reorderFolders.mockResolvedValue([]);
    expect(await reorderProjectFolders("a", ["y", "x"])).toBe(true);
    expect(mocked.reorderFolders).toHaveBeenCalledWith("a", ["y", "x"]);
    expect(folders.value.find((f) => f.id === "y")?.sortOrder).toBe(0);
  });

  it("Move Up / Down of a pinned chat stays within its folder", async () => {
    folders.value = [...folders.value, folder({ id: "pf", projectId: "a" })];
    workspaces.value = [
      makeWorkspace({ id: "p1", projectId: "a", pinned: true, pinOrder: 0 }),
      makeWorkspace({ id: "p2", projectId: "a", pinned: true, pinOrder: 1, folderId: "pf" }),
      makeWorkspace({ id: "p3", projectId: "a", pinned: true, pinOrder: 2 }),
    ];
    mocked.reorderPinnedWorkspaces.mockResolvedValue([]);
    await movePinnedWorkspace("p3", -1);
    expect(mocked.reorderPinnedWorkspaces).toHaveBeenCalledWith("a", ["p3", "p1", "p2"]);
  });
});
