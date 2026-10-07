/**
 * I-165 / I-202: folder actions against a mocked API: create / rename / delete, moving chats in
 * and out, and rewriting a container's manual order (`reorderChatList`), also across environments.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Folder, ReorderChatListRequest } from "@glade/protocol";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    createFolder: vi.fn(),
    updateFolder: vi.fn(),
    deleteFolder: vi.fn(),
    updateWorkspace: vi.fn(),
    reorderChatList: vi.fn(),
  },
}));

import { api } from "@glade/app-core/lib/api";
import { makeWorkspace } from "@glade/app-core/test/fixtures";
import { chatListOf, folders, looseWorkspaces, projects, workspaces, workspacesInFolder } from "./store";
import { createFolder, deleteFolder, moveWorkspaceToFolder, renameFolder, reorderChatList } from "./folder-actions";
import { chatEntryId } from "./folders";
import { resetClientOrders } from "./env-order";
import { toasts } from "./toasts";

const mocked = vi.mocked(api);
const folder = (over: Partial<Folder> & { id: string }): Folder => ({ name: over.id, projectId: null, sortOrder: 0, createdAt: 0, ...over });
const top = (projectId: string | null) => chatListOf(projectId).entries.map(chatEntryId);

beforeEach(() => {
  vi.clearAllMocks();
  resetClientOrders();
  toasts.value = [];
  projects.value = [];
  folders.value = [folder({ id: "F", sortOrder: 1 })];
  workspaces.value = [];
  mocked.reorderChatList.mockResolvedValue({ workspaces: [], folders: [] });
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

  it("moves chats in and out (optimistic, rolled back on failure)", async () => {
    workspaces.value = [makeWorkspace({ id: "w", projectId: null })];
    mocked.updateWorkspace.mockImplementation(async (id, patch) => ({ ...workspaces.value.find((w) => w.id === id)!, ...patch }));
    expect(await moveWorkspaceToFolder("w", "F")).toBe(true);
    expect(mocked.updateWorkspace).toHaveBeenCalledWith("w", { folderId: "F" });
    expect(workspacesInFolder("F").map((w) => w.id)).toEqual(["w"]);

    mocked.updateWorkspace.mockRejectedValue(new Error("nope"));
    expect(await moveWorkspaceToFolder("w", null)).toBe(false);
    expect(workspacesInFolder("F").map((w) => w.id)).toEqual(["w"]);
    expect(looseWorkspaces(null)).toEqual([]);
  });
});

describe("reorderChatList (I-202)", () => {
  beforeEach(() => {
    folders.value = [folder({ id: "F", projectId: "p", sortOrder: 1 })];
    workspaces.value = [
      makeWorkspace({ id: "a", projectId: "p", sortOrder: 0 }),
      makeWorkspace({ id: "b", projectId: "p", sortOrder: 2 }),
      makeWorkspace({ id: "in", projectId: "p", sortOrder: 0, folderId: "F" }),
      makeWorkspace({ id: "pin", projectId: "p", pinned: true, pinOrder: 0, sortOrder: 9 }),
    ];
  });

  it("reorders a project's top level optimistically (chats and folders mixed) and sends it", async () => {
    expect(top("p")).toEqual(["a", "F", "b"]);
    const done = reorderChatList("p", null, ["b", "a", "F"]);
    expect(top("p")).toEqual(["b", "a", "F"]);
    expect(mocked.reorderChatList).toHaveBeenCalledWith({ projectId: "p", folderId: null, ids: ["b", "a", "F"] });
    expect(await done).toBe(true);
    expect(chatListOf("p").pinned.map((c) => c.id)).toEqual(["pin"]);
  });

  it("moves a chat into a folder at a position, and out of it to the top level", async () => {
    await reorderChatList("p", "F", ["in", "b"]);
    expect(mocked.reorderChatList).toHaveBeenLastCalledWith({ projectId: "p", folderId: "F", ids: ["in", "b"] });
    expect(workspacesInFolder("F").map((w) => w.id)).toEqual(["in", "b"]);
    expect(top("p")).toEqual(["a", "F"]);

    await reorderChatList("p", null, ["in", "a", "F"]);
    expect(top("p")).toEqual(["in", "a", "F"]);
    expect(workspacesInFolder("F").map((w) => w.id)).toEqual(["b"]);
  });

  it("names members the drag didn't (the server wants the whole container)", async () => {
    await reorderChatList("p", null, ["F", "a"]);
    expect((mocked.reorderChatList.mock.calls[0]![0] as ReorderChatListRequest).ids).toEqual(["F", "a", "b"]);
  });

  it("refuses items of another list and rolls back on failure", async () => {
    workspaces.value = [...workspaces.value, makeWorkspace({ id: "other", projectId: "q" })];
    mocked.reorderChatList.mockRejectedValue(new Error("offline"));
    expect(await reorderChatList("p", null, ["other", "b", "a", "F"])).toBe(false);
    expect((mocked.reorderChatList.mock.calls[0]![0] as ReorderChatListRequest).ids).toEqual(["b", "a", "F"]);
    expect(top("p")).toEqual(["a", "F", "b"]);
    expect(toasts.value[0]?.message).toContain("offline");
  });

  it("standalone chats of several environments: each server gets its part, this device keeps the interleave", async () => {
    folders.value = [];
    workspaces.value = [
      makeWorkspace({ id: "l1", projectId: null, sortOrder: 0 }),
      makeWorkspace({ id: "l2", projectId: null, sortOrder: 1 }),
      makeWorkspace({ id: "r1", projectId: null, sortOrder: 0, environmentId: "remote" }),
    ];
    const calls: string[][] = [];
    mocked.reorderChatList.mockImplementation(async (body) => {
      calls.push(body.ids);
      return { workspaces: [], folders: [] };
    });
    await reorderChatList(null, null, ["l2", "r1", "l1"]);
    expect(top(null)).toEqual(["l2", "r1", "l1"]);
    // Both environments' parts (unknown connections fall back to the local API in tests).
    expect(calls).toContainEqual(["l2", "l1"]);
  });
});
