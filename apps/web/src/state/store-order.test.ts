import { beforeEach, describe, expect, it } from "vitest";
import { chats, chatsForProject } from "./store";
import { makeChat } from "@/test/fixtures";

describe("chatsForProject", () => {
  beforeEach(() => {
    chats.value = [
      makeChat({ id: "old", projectId: "p", lastActivityAt: 1 }),
      makeChat({ id: "new", projectId: "p", lastActivityAt: 3 }),
      makeChat({ id: "pinned-old", projectId: "p", pinned: true, lastActivityAt: 0 }),
      makeChat({ id: "archived", projectId: "p", archived: true, lastActivityAt: 9 }),
      makeChat({ id: "other", projectId: null, lastActivityAt: 5 }),
    ];
  });
  it("lists pinned first, then newest first, without archived", () => {
    expect(chatsForProject("p").map((c) => c.id)).toEqual(["pinned-old", "new", "old"]);
  });
  it("can include archived chats", () => {
    expect(chatsForProject("p", true).map((c) => c.id)).toContain("archived");
  });
  it("lists standalone chats for null", () => {
    expect(chatsForProject(null).map((c) => c.id)).toEqual(["other"]);
  });
});
