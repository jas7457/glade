/**
 * I-165: folders in the iPhone chat list: grouping (top-level folders with projects and chats, a
 * project's folders opening in place), search, and the Move to Folder / folder action sheets.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { MemoryRouter } from "react-router";
import type { Folder } from "@glade/protocol";
import { connections } from "@/state/env-registry";
import { savedEnvironments } from "@/state/saved-environments";
import { folders, projects, workspaces } from "@/state/store";
import { closedProjects } from "@/state/ui";
import { makeProject, makeWorkspace } from "@/test/fixtures";
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

function renderList(query = "") {
  return render(
    <MemoryRouter>
      <ChatList onOpen={vi.fn()} query={query} />
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
      makeProject({ id: "p2", name: "Beta", sortOrder: 2, environmentId: "m1", folderId: "W" }),
    ];
    folders.value = [folder({ id: "W", name: "Work", sortOrder: 0 }), folder({ id: "B", name: "Bugs", projectId: "p1" })];
    workspaces.value = [
      makeWorkspace({ id: "c1", projectId: "p1", title: "Loose one", environmentId: "m1" }),
      makeWorkspace({ id: "c2", projectId: "p1", title: "Filed bug", folderId: "B", environmentId: "m1" }),
      makeWorkspace({ id: "c3", projectId: "p2", title: "In beta", environmentId: "m1" }),
      makeWorkspace({ id: "c4", projectId: null, title: "Standalone in work", folderId: "W", environmentId: "m1" }),
      makeWorkspace({ id: "c5", projectId: null, title: "Outside", environmentId: "m1" }),
    ];
  });

  it("groups top-level folders (projects + chats), then projects with their folders first", () => {
    expect(chatGroups().map((g) => g.kind)).toEqual(["folder", "project", "standalone"]);
    const { container } = renderList();
    const work = container.querySelector("section[data-folder-id=W]") as HTMLElement;
    expect(work.querySelector("[data-project-id=p2]")).toBeTruthy();
    expect(ids(work)).toEqual(["c3", "c4"]);
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    expect(alpha.querySelector("button[data-folder-id=B]")).toBeTruthy();
    expect(ids(alpha)).toEqual(["c2", "c1"]);
    expect(ids(container.querySelector("section[aria-label=Chats]")!)).toEqual(["c5"]);
  });

  it("a project's folder opens and closes in place; search keeps only matches", () => {
    const { container, rerender } = renderList();
    fireEvent.click(container.querySelector("button[data-folder-id=B]")!);
    expect(ids(container.querySelector("[data-project-id=p1]")!)).toEqual(["c1"]);
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

  it("New Folder… creates a top-level folder for a standalone chat and moves it in", async () => {
    renderList();
    fireEvent.contextMenu(screen.getByText("Outside"));
    fireEvent.click(screen.getByRole("button", { name: "Move to Folder…" }));
    fireEvent.click(screen.getByRole("button", { name: "New Folder…" }));
    fireEvent.input(screen.getByRole("textbox", { name: "Folder name" }), { target: { value: "Later" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createFolder).toHaveBeenCalledWith({ name: "Later", projectId: null }));
    await waitFor(() => expect(api.updateWorkspace).toHaveBeenCalledWith("c5", { folderId: "NEW" }));
  });

  it("long-press on a folder offers Rename and Delete", async () => {
    const { container } = renderList();
    fireEvent.contextMenu(container.querySelector("section[data-folder-id=W] > button")!);
    fireEvent.click(screen.getByRole("button", { name: "Delete Folder…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Folder" }));
    await waitFor(() => expect(api.deleteFolder).toHaveBeenCalledWith("W"));
  });
});
