import { describe, expect, it } from "vitest";
import { makeWorkspace } from "@glade/app-core/test/fixtures";
import { groupChatFolders } from "./group-folder";

describe("groupChatFolders (I-213)", () => {
  it("lists the group's distinct chat folders, the newest chat's folder first", () => {
    const list = [
      makeWorkspace({ id: "a", projectId: "g", cwd: "/repo/web", createdAt: 10 }),
      makeWorkspace({ id: "b", projectId: "g", cwd: "/repo/polaris", createdAt: 30 }),
      makeWorkspace({ id: "c", projectId: "g", cwd: "/repo/web", createdAt: 40 }),
      makeWorkspace({ id: "d", projectId: "g", cwd: "/other/checkout", createdAt: 20 }),
      makeWorkspace({ id: "e", projectId: "p", cwd: "/elsewhere", createdAt: 50 }),
      makeWorkspace({ id: "f", projectId: null, cwd: "/scratch", createdAt: 60 }),
    ];
    expect(groupChatFolders("g", list)).toEqual(["/repo/web", "/repo/polaris", "/other/checkout"]);
  });

  it("is empty for a group without chats", () => {
    expect(groupChatFolders("g", [makeWorkspace({ id: "a", projectId: "p", cwd: "/x" })])).toEqual([]);
  });
});
