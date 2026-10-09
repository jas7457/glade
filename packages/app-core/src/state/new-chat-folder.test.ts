/** I-213: the folder picked for a group project's new chat. */
import { beforeEach, describe, expect, it } from "vitest";
import { makeProject } from "@glade/app-core/test/fixtures";
import {
  folderRequestFor,
  isGroupProject,
  needsNewChatFolder,
  newChatFolder,
  newChatFolderFor,
  resetNewChatFolder,
  setNewChatFolder,
} from "./new-chat-folder";

const group = makeProject({ id: "g", path: null });
const project = makeProject({ id: "p" });

beforeEach(() => resetNewChatFolder());

describe("new chat folder", () => {
  it("isGroupProject: only path null", () => {
    expect(isGroupProject(group)).toBe(true);
    expect(isGroupProject(project)).toBe(false);
    expect(isGroupProject(undefined)).toBe(false);
    expect(isGroupProject(null)).toBe(false);
  });

  it("holds one folder for one project", () => {
    setNewChatFolder("g", "/Users/me/a");
    expect(newChatFolderFor("g")).toBe("/Users/me/a");
    expect(newChatFolderFor("h")).toBeNull();
    expect(newChatFolderFor(null)).toBeNull();
    setNewChatFolder("h", "/Users/me/b");
    expect(newChatFolderFor("g")).toBeNull();
    setNewChatFolder("h", null);
    expect(newChatFolder.value).toBeNull();
  });

  it("needsNewChatFolder: a group without a choice; never a normal project", () => {
    expect(needsNewChatFolder(group)).toBe(true);
    expect(needsNewChatFolder(project)).toBe(false);
    expect(needsNewChatFolder(undefined)).toBe(false);
    setNewChatFolder("g", "/Users/me/a");
    expect(needsNewChatFolder(group)).toBe(false);
    resetNewChatFolder();
    expect(needsNewChatFolder(group)).toBe(true);
  });

  it("folderRequestFor sends the folder only for its project", () => {
    expect(folderRequestFor("g")).toEqual({});
    setNewChatFolder("g", "/Users/me/a");
    expect(folderRequestFor("g")).toEqual({ folder: "/Users/me/a" });
    expect(folderRequestFor("p")).toEqual({});
    expect(folderRequestFor(null)).toEqual({});
  });
});
