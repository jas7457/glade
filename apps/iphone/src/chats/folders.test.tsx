/**
 * I-165 / I-202: folders in the iPhone chat list: grouping (each list's chats and folders in their
 * one manual order, Chats-section folders with standalone chats, folders opening in place),
 * search, and the Move to Folder / folder action sheets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { MemoryRouter } from "react-router";
import type { Folder } from "@glade/protocol";
import { connections } from "@glade/app-core/state/env-registry";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { folders, projects, workspaces } from "@glade/app-core/state/store";
import { closedProjects } from "@glade/app-core/state/ui";
import { makeProject, makeWorkspace } from "@glade/app-core/test/fixtures";
import { fakeEnv } from "~/test/fake-env";
import { ChatList } from "./ChatList";
import { chatGroups } from "./chat-groups";

const ids = (el: Element) => [...el.querySelectorAll("[data-chat-id]")].map((e) => e.getAttribute("data-chat-id"));
const folder = (over: Partial<Folder> & { id: string }): Folder => ({ name: over.id, projectId: null, sortOrder: 0, createdAt: 0, environmentId: "m1", ...over });

const api = {
  updateWorkspace: vi.fn(async (id: string, patch: object) => ({ ...workspaces.value.find((w) => w.id === id)!, ...patch })),
  createFolder: vi.fn(async (body: { name: string; projectId: string | null }) => folder({ id: "NEW", ...body })),
  updateFolder: vi.fn(async (id: string, patch: object) => ({ ...folders.value.find((f) => f.id === id)!, ...patch })),
  deleteFolder: vi.fn(async () => undefined),
};

const onNewChatInFolder = vi.fn();

function renderList(query = "") {
  return render(
    <MemoryRouter>
      <ChatList onOpen={vi.fn()} query={query} onNewChatInFolder={onNewChatInFolder} />
    </MemoryRouter>,
  );
}

describe("iPhone chat list folders (I-165)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    closedProjects.value = new Set();
    const env = fakeEnv("m1", "Studio");
    (env as { api: unknown }).api = api;
    connections.value = [env];
    savedEnvironments.value = [{ id: "m1", name: "Studio", urls: ["http://m1.test:4327"], token: "t" }];
    projects.value = [
      makeProject({ id: "p1", name: "Alpha", sortOrder: 1, environmentId: "m1" }),
      makeProject({ id: "p2", name: "Beta", sortOrder: 2, environmentId: "m1" }),
    ];
    folders.value = [folder({ id: "W", name: "Work", sortOrder: 1 }), folder({ id: "B", name: "Bugs", projectId: "p1", sortOrder: 1 })];
    workspaces.value = [
      makeWorkspace({ id: "c0", projectId: "p1", title: "First", sortOrder: 0, environmentId: "m1" }),
      makeWorkspace({ id: "c1", projectId: "p1", title: "Loose one", sortOrder: 2, environmentId: "m1" }),
      makeWorkspace({ id: "c2", projectId: "p1", title: "Filed bug", folderId: "B", sortOrder: 0, environmentId: "m1" }),
      makeWorkspace({ id: "c3", projectId: "p2", title: "In beta", environmentId: "m1" }),
      makeWorkspace({ id: "c4", projectId: null, title: "Standalone in work", folderId: "W", sortOrder: 0, environmentId: "m1" }),
      makeWorkspace({ id: "c5", projectId: null, title: "Outside", sortOrder: 0, environmentId: "m1" }),
    ];
  });

  it("lists projects (never in folders), each with its chats and folders in one order, then the Chats section with its folders", () => {
    expect(chatGroups().map((g) => g.kind)).toEqual(["project", "project", "standalone"]);
    const { container } = renderList();
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    expect([...alpha.querySelectorAll("[data-folder-id], [data-chat-id]")].map((e) => e.getAttribute("data-folder-id") ?? e.getAttribute("data-chat-id"))).toEqual(["c0", "B", "c2", "c1"]);
    const chats = container.querySelector("section[aria-label=Chats]")!;
    expect(chats.querySelector("button[data-folder-id=W]")).toBeTruthy();
    expect(ids(chats)).toEqual(["c5", "c4"]);
  });

  it("a project's folder opens and closes in place; search keeps only matches", () => {
    const { container, rerender } = renderList();
    fireEvent.click(container.querySelector("button[data-folder-id=B]")!);
    expect(ids(container.querySelector("[data-project-id=p1]")!)).toEqual(["c0", "c1"]);
    expect(closedProjects.value.has("B")).toBe(true);
    rerender(
      <MemoryRouter>
        <ChatList onOpen={vi.fn()} query="bug" />
      </MemoryRouter>,
    );
    expect(ids(container)).toEqual(["c2"]);
    expect(chatGroups("bug").map((g) => g.kind)).toEqual(["project"]);
  });

  it("Move to Folder from a chat's actions lists its project's folders", async () => {
    renderList();
    fireEvent.contextMenu(screen.getByText("Loose one"));
    fireEvent.click(screen.getByRole("button", { name: "Move to Folder…" }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).queryByRole("button", { name: "Work" })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Bugs" }));
    await waitFor(() => expect(api.updateWorkspace).toHaveBeenCalledWith("c1", { folderId: "B" }));
  });

  it("New Folder… creates a Chats-section folder for a standalone chat and moves it in", async () => {
    renderList();
    fireEvent.contextMenu(screen.getByText("Outside"));
    fireEvent.click(screen.getByRole("button", { name: "Move to Folder…" }));
    fireEvent.click(screen.getByRole("button", { name: "New Folder…" }));
    fireEvent.input(screen.getByRole("textbox", { name: "Folder name" }), { target: { value: "Later" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createFolder).toHaveBeenCalledWith({ name: "Later", projectId: null }));
    await waitFor(() => expect(api.updateWorkspace).toHaveBeenCalledWith("c5", { folderId: "NEW" }));
  });

  it("a folder's actions start a new chat in it (I-215)", () => {
    const { container } = renderList();
    fireEvent.contextMenu(container.querySelector("button[data-folder-id=B]")!);
    fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
    expect(onNewChatInFolder).toHaveBeenCalledWith(expect.objectContaining({ id: "B", projectId: "p1" }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull(); // the sheet closed
  });

  it("long-press on a folder offers Rename and Delete", async () => {
    const { container } = renderList();
    fireEvent.contextMenu(container.querySelector("button[data-folder-id=W]")!);
    fireEvent.click(screen.getByRole("button", { name: "Delete Folder…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Folder" }));
    await waitFor(() => expect(api.deleteFolder).toHaveBeenCalledWith("W"));
  });
});
