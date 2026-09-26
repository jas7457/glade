import { beforeEach, describe, expect, it } from "vitest";
import { chats, chatsForProject, projects, sortedProjects } from "./store";
import { makeChat, makeProject } from "@/test/fixtures";

describe("chatsForProject", () => {
  beforeEach(() => {
    chats.value = [
      makeChat({ id: "old", projectId: "p", createdAt: 1, lastActivityAt: 100 }),
      makeChat({ id: "new", projectId: "p", createdAt: 3, lastActivityAt: 3 }),
      makeChat({ id: "pin-b", projectId: "p", pinned: true, pinOrder: 1, createdAt: 9 }),
      makeChat({ id: "pin-a", projectId: "p", pinned: true, pinOrder: 0, createdAt: 0 }),
      makeChat({ id: "other", projectId: null, createdAt: 5 }),
    ];
  });
  it("lists pinned first by pinOrder, then newest-created first (activity doesn't matter)", () => {
    expect(chatsForProject("p").map((c) => c.id)).toEqual(["pin-a", "pin-b", "new", "old"]);
  });
  it("puts pinned chats without a pinOrder after ordered ones", () => {
    chats.value = [...chats.value, makeChat({ id: "pin-x", projectId: "p", pinned: true, createdAt: 50 })];
    expect(chatsForProject("p").map((c) => c.id).slice(0, 3)).toEqual(["pin-a", "pin-b", "pin-x"]);
  });
  it("lists standalone chats for null", () => {
    expect(chatsForProject(null).map((c) => c.id)).toEqual(["other"]);
  });
});

describe("sortedProjects", () => {
  it("orders by sortOrder, never by activity", () => {
    projects.value = [
      makeProject({ id: "a", sortOrder: 2, lastActivityAt: 999 }),
      makeProject({ id: "b", sortOrder: 0 }),
      makeProject({ id: "c", sortOrder: 1, lastActivityAt: 5 }),
    ];
    expect(sortedProjects.value.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });
});
