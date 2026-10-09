/** I-215: the sidebar folder a new chat starts in, and the route params that carry it. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@glade/app-core/lib/api", () => ({ api: {} }));

import { folders } from "./store";
import { folderIdRequestFor, newChatInFolder, newChatTargetFolder, setNewChatInFolder } from "./new-chat-in-folder";
import { routes } from "../app/routes";

const folder = (id: string, projectId: string | null) => ({ id, name: id, projectId, sortOrder: 0, createdAt: 0 });

beforeEach(() => {
  setNewChatInFolder(null);
  folders.value = [folder("F", null), folder("PF", "p1")];
});

describe("new chat in a folder", () => {
  it("sends the folder only to the list it belongs to", () => {
    setNewChatInFolder("F");
    expect(folderIdRequestFor(null)).toEqual({ folderId: "F" });
    expect(folderIdRequestFor("p1")).toEqual({});
    setNewChatInFolder("PF");
    expect(folderIdRequestFor("p1")).toEqual({ folderId: "PF" });
    expect(folderIdRequestFor(null)).toEqual({});
    expect(newChatTargetFolder("p1")?.name).toBe("PF");
  });

  it("sends nothing without a choice or when the folder is gone", () => {
    expect(folderIdRequestFor(null)).toEqual({});
    setNewChatInFolder("F");
    folders.value = [];
    expect(folderIdRequestFor(null)).toEqual({});
    expect(newChatInFolder.value).toBe("F");
  });
});

describe("new-chat routes with a folder", () => {
  it("add ?folder= to the standalone and project new-chat screens", () => {
    expect(routes.home(null, "F")).toBe("/?folder=F");
    expect(routes.home()).toBe("/");
    expect(routes.project("p1", null, "PF")).toBe("/projects/p1?folder=PF");
    expect(routes.project("p1", null)).toBe("/projects/p1");
    expect(routes.home("remote", "F")).toBe("/e/remote?folder=F");
  });
});
