/** I-215: the new-chat screen opened for a folder says so and hands the folder to chat creation. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/preact";

vi.mock("@glade/app-core/lib/api", () => ({ api: {} }));
vi.mock("@glade/app-core/features/chat/Composer", () => ({ Composer: () => <div /> }));
vi.mock("@glade/app-core/features/chat/context-bar", () => ({ ContextBar: () => <div /> }));
vi.mock("@glade/app-core/features/chat/OpenInButton", () => ({ OpenInButton: () => <div /> }));

import { folders, projects } from "@glade/app-core/state/store";
import { folderIdRequestFor, setNewChatInFolder } from "@glade/app-core/state/new-chat-in-folder";
import { makeProject } from "@glade/app-core/test/fixtures";
import { NewChatView } from "@glade/app-core/features/chat/NewChatView";

beforeEach(() => {
  setNewChatInFolder(null);
  projects.value = [makeProject({ id: "p1", name: "Alpha" })];
  folders.value = [
    { id: "F", name: "Work", projectId: null, sortOrder: 0, createdAt: 0 },
    { id: "PF", name: "Bugs", projectId: "p1", sortOrder: 0, createdAt: 0 },
  ];
});

describe("NewChatView folder (I-215)", () => {
  it("names the folder of a standalone chat and sends it while mounted", () => {
    const { unmount } = render(<NewChatView projectId={null} folderId="F" />);
    expect(screen.getByTestId("new-chat-folder").textContent).toContain("in Work");
    expect(folderIdRequestFor(null)).toEqual({ folderId: "F" });
    unmount();
    expect(folderIdRequestFor(null)).toEqual({});
  });

  it("names the folder of a project chat", () => {
    render(<NewChatView projectId="p1" folderId="PF" />);
    expect(screen.getByTestId("new-chat-folder").textContent).toContain("in Bugs");
    expect(folderIdRequestFor("p1")).toEqual({ folderId: "PF" });
  });

  it("ignores a folder of another list or one that doesn't exist", () => {
    render(<NewChatView projectId={null} folderId="PF" />);
    expect(screen.queryByTestId("new-chat-folder")).toBeNull();
    expect(folderIdRequestFor(null)).toEqual({});
  });

  it("shows no folder note without one", () => {
    render(<NewChatView projectId={null} />);
    expect(screen.queryByTestId("new-chat-folder")).toBeNull();
  });
});
