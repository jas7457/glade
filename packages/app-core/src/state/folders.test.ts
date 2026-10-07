/**
 * I-165 / I-202: chat lists with folders (memberships, the mixed manual order, environments) and
 * the store's selectors.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Folder } from "@glade/protocol";
import { makeProject, makeWorkspace } from "@glade/app-core/test/fixtures";
import { buildChatList, chatEntryId, chatsOfView, workspaceFolderId } from "./folders";
import * as store from "./store";
import { resetClientOrders } from "./env-order";

const folder = (over: Partial<Folder> & { id: string }): Folder => ({ name: over.id, projectId: null, sortOrder: 0, createdAt: 0, ...over });
const envOf = (item: { environmentId?: string }) => item.environmentId ?? "L";

describe("buildChatList (I-202)", () => {
  const view = (chats: ReturnType<typeof makeWorkspace>[], folders: Folder[], slots: { pin?: string[]; order?: string[] } = {}) =>
    buildChatList({ chats, folders, foldersById: new Map(folders.map((f) => [f.id, f])), envOf, pinSlots: slots.pin ?? [], orderSlots: slots.order ?? [], envOrder: ["L", "R"] });

  it("pinned outside folders first, then chats and folders in one manual order; folders hold their chats", () => {
    const v = view(
      [
        makeWorkspace({ id: "c2", projectId: "p", sortOrder: 2 }),
        makeWorkspace({ id: "c0", projectId: "p", sortOrder: 0 }),
        makeWorkspace({ id: "pin", projectId: "p", pinned: true, pinOrder: 0, sortOrder: 5 }),
        makeWorkspace({ id: "in1", projectId: "p", sortOrder: 1, folderId: "F" }),
        makeWorkspace({ id: "in0", projectId: "p", sortOrder: 0, folderId: "F" }),
        makeWorkspace({ id: "inPin", projectId: "p", pinned: true, pinOrder: 1, sortOrder: 9, folderId: "F" }),
      ],
      [folder({ id: "F", projectId: "p", sortOrder: 1 })],
    );
    expect(v.pinned.map((c) => c.id)).toEqual(["pin"]);
    expect(v.entries.map(chatEntryId)).toEqual(["c0", "F", "c2"]);
    const f = v.entries[1];
    expect(f?.kind === "folder" && f.chats.map((c) => c.id)).toEqual(["inPin", "in0", "in1"]);
    expect(chatsOfView(v).map((c) => c.id)).toEqual(["pin", "c0", "inPin", "in0", "in1", "c2"]);
  });

  it("chats without a sortOrder (older server) go on top, newest first; stale folder ids show outside", () => {
    const v = view(
      [
        makeWorkspace({ id: "numbered", projectId: null, sortOrder: 0 }),
        makeWorkspace({ id: "old", projectId: null, createdAt: 1 }),
        makeWorkspace({ id: "new", projectId: null, createdAt: 2 }),
        makeWorkspace({ id: "stale", projectId: null, sortOrder: 1, folderId: "gone" }),
      ],
      [],
    );
    expect(v.entries.map(chatEntryId)).toEqual(["new", "old", "numbered", "stale"]);
  });

  it("interleaves environments by the device's slots (pinned and mixed separately)", () => {
    const v = view(
      [
        makeWorkspace({ id: "l", projectId: null, sortOrder: 0 }),
        makeWorkspace({ id: "r", projectId: null, sortOrder: 0, environmentId: "R" }),
        makeWorkspace({ id: "lp", projectId: null, pinned: true, pinOrder: 0 }),
        makeWorkspace({ id: "rp", projectId: null, pinned: true, pinOrder: 0, environmentId: "R" }),
      ],
      [folder({ id: "rf", sortOrder: 1, environmentId: "R" })],
      { pin: ["R:rp", "L:lp"], order: ["R:r", "L:l", "R:rf"] },
    );
    expect(v.pinned.map((c) => c.id)).toEqual(["rp", "lp"]);
    expect(v.entries.map(chatEntryId)).toEqual(["r", "l", "rf"]);
  });
});

describe("workspaceFolderId", () => {
  const folders = new Map([
    ["top", folder({ id: "top" })],
    ["pf", folder({ id: "pf", projectId: "p" })],
  ]);
  it("takes Chats-section folders for standalone chats and the chat's project's folders otherwise", () => {
    expect(workspaceFolderId(makeWorkspace({ id: "1", projectId: null, folderId: "top" }), folders, envOf)).toBe("top");
    expect(workspaceFolderId(makeWorkspace({ id: "2", projectId: "p", folderId: "pf" }), folders, envOf)).toBe("pf");
    expect(workspaceFolderId(makeWorkspace({ id: "3", projectId: "p", folderId: "top" }), folders, envOf)).toBeNull();
    expect(workspaceFolderId(makeWorkspace({ id: "4", projectId: "q", folderId: "pf" }), folders, envOf)).toBeNull();
    expect(workspaceFolderId(makeWorkspace({ id: "5", projectId: null, folderId: "gone" }), folders, envOf)).toBeNull();
  });
});

describe("store: folders (I-165)", () => {
  beforeEach(() => {
    resetClientOrders();
    store.projects.value = [makeProject({ id: "p", sortOrder: 1 }), makeProject({ id: "q", sortOrder: 2 })];
    store.folders.value = [folder({ id: "top", sortOrder: 0 }), folder({ id: "pf", projectId: "p" })];
    store.workspaces.value = [
      makeWorkspace({ id: "w1", projectId: "p", folderId: "pf" }),
      makeWorkspace({ id: "w2", projectId: "p" }),
      makeWorkspace({ id: "w3", projectId: null, folderId: "top" }),
      makeWorkspace({ id: "w4", projectId: null }),
    ];
  });

  it("groups projects and chats", () => {
    // Projects are always top level (I-202).
    expect(store.sortedProjects.value.map((p) => p.id)).toEqual(["p", "q"]);
    // w4 has no sortOrder (an older server's): above the numbered folder.
    expect(store.chatListOf(null).entries.map(chatEntryId)).toEqual(["w4", "top"]);
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
