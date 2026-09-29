/**
 * I-165: folders in the desktop sidebar: grouping, collapsing, dropping projects and chats onto a
 * folder row, the "Move to Folder" menu, and deleting a folder.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { MemoryRouter } from "react-router";
import type { Folder } from "@glade/protocol";

vi.mock("@/lib/api", () => ({
  api: {
    reorderProjects: vi.fn(async () => []),
    reorderPinnedWorkspaces: vi.fn(async () => []),
    updateProject: vi.fn(async (id: string, patch: object) => ({ ...projects.value.find((p) => p.id === id), ...patch })),
    updateWorkspace: vi.fn(async (id: string, patch: object) => ({ ...workspaces.value.find((w) => w.id === id), ...patch })),
    createFolder: vi.fn(async (body: { name: string; projectId: string | null }) => ({ id: "NEW", sortOrder: -1, createdAt: 1, ...body })),
    deleteFolder: vi.fn(async () => undefined),
    getProjectGit: vi.fn(async () => ({ isRepo: false })),
  },
}));

import { api } from "@/lib/api";
import { ConfirmHost, TooltipProvider } from "@/ui";
import { folders, projects, workspaces } from "@/state/store";
import { closedProjects } from "@/state/ui";
import { makeProject, makeWorkspace } from "@/test/fixtures";
import { Sidebar } from "./Sidebar";
import { renamingFolderId } from "./folder-menu";

const folder = (over: Partial<Folder> & { id: string }): Folder => ({ name: over.id, projectId: null, sortOrder: 0, createdAt: 0, ...over });

function renderSidebar() {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/"]}>
        <Sidebar />
        <ConfirmHost />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

const box = (top: number) => () => ({ top, bottom: top + 30, left: 0, right: 200, height: 30, width: 200, x: 0, y: top, toJSON() {} }) as DOMRect;

beforeEach(() => {
  vi.clearAllMocks();
  closedProjects.value = new Set();
  renamingFolderId.value = null;
  projects.value = [
    makeProject({ id: "p1", name: "Alpha", sortOrder: 1 }),
    makeProject({ id: "p2", name: "Beta", sortOrder: 2 }),
    makeProject({ id: "p3", name: "Gamma", sortOrder: 3, folderId: "F" }),
  ];
  folders.value = [folder({ id: "F", name: "Work", sortOrder: 0 }), folder({ id: "PF", name: "Bugs", projectId: "p1" })];
  workspaces.value = [
    makeWorkspace({ id: "c1", projectId: "p1", title: "Loose one" }),
    makeWorkspace({ id: "c2", projectId: "p1", title: "Filed", folderId: "PF", status: "working", running: true }),
    makeWorkspace({ id: "c3", projectId: null, title: "Standalone in F", folderId: "F" }),
    makeWorkspace({ id: "c4", projectId: null, title: "Outside" }),
  ];
});

describe("sidebar folders (I-165)", () => {
  it("groups projects and chats into folders", () => {
    const { container } = renderSidebar();
    const work = container.querySelector("[data-folder-id=F]") as HTMLElement;
    expect(within(work).getByRole("button", { name: "Work" })).toBeTruthy();
    expect(work.querySelector("[data-project-id=p3]")).toBeTruthy();
    expect(work.querySelector("[data-chat-id=c3]")).toBeTruthy();
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    const bugs = alpha.querySelector("[data-folder-id=PF]") as HTMLElement;
    expect(bugs.querySelector("[data-chat-id=c2]")).toBeTruthy();
    // Folders come first in a project, then its chats outside folders.
    expect([...alpha.querySelectorAll("[data-folder-id], [data-chat-id]")].map((el) => el.getAttribute("data-folder-id") ?? el.getAttribute("data-chat-id"))).toEqual(["PF", "c2", "c1"]);
    // The Chats group only lists standalone chats outside folders.
    expect(container.querySelectorAll("[data-chat-id=c3]")).toHaveLength(1);
    expect(screen.getByText("Outside")).toBeTruthy();
  });

  it("collapses a folder and shows the most urgent status inside", () => {
    const { container } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Bugs" }));
    const bugs = container.querySelector("[data-folder-id=PF]") as HTMLElement;
    expect(bugs.querySelector("[data-chat-id]")).toBeNull();
    expect(bugs.querySelector("[data-slot=trailing] [data-status=working]")).toBeTruthy();
    expect(closedProjects.value.has("PF")).toBe(true);
  });

  it("dropping a project on a folder's row puts it in the folder", async () => {
    const { container } = renderSidebar();
    // Rows of the project list: Work (folder) 0, Gamma 32, Alpha 64, Beta 96.
    const tops: Record<string, number> = { F: 0, p3: 32, p1: 64, p2: 96 };
    for (const el of container.querySelectorAll<HTMLElement>("[data-sort-group=projects]")) el.getBoundingClientRect = box(tops[el.dataset.sortId!]!);
    const beta = within(container.querySelector("[data-project-id=p2]") as HTMLElement).getByRole("button", { name: "Beta" });
    fireEvent.pointerDown(beta, { button: 0, clientX: 10, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 15 });
    expect(container.querySelector("[data-folder-id=F] [data-selected], [data-folder-id=F] .ring-accent\\/60")).toBeTruthy();
    fireEvent.pointerUp(window, { clientX: 10, clientY: 15 });
    fireEvent.click(document.body);
    expect(api.updateProject).toHaveBeenCalledWith("p2", { folderId: "F" });
    expect(api.reorderProjects).not.toHaveBeenCalled();
    await waitFor(() => expect(container.querySelector("[data-folder-id=F] [data-project-id=p2]")).toBeTruthy());
  });

  it("dragging a chat onto its project's folder files it; onto the project row takes it out", () => {
    const { container } = renderSidebar();
    (container.querySelector("[data-drop-into=PF]") as HTMLElement).getBoundingClientRect = box(200);
    const row = container.querySelector("[data-chat-id=c1] button") as HTMLElement;
    fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 210 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 210 });
    fireEvent.click(document.body); // the click ending a drag (the row itself moved away)
    expect(api.updateWorkspace).toHaveBeenCalledWith("c1", { folderId: "PF" });

    // A standalone chat can't go in a project's folder.
    const outside = container.querySelector("[data-chat-id=c4] button") as HTMLElement;
    fireEvent.pointerDown(outside, { button: 0, clientX: 10, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 210 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 210 });
    fireEvent.click(outside);
    expect(api.updateWorkspace).toHaveBeenCalledTimes(1);

    const alphaRow = container.querySelector("[data-project-id=p1] > [data-drop-into='']") as HTMLElement;
    alphaRow.getBoundingClientRect = box(400);
    const filed = container.querySelector("[data-chat-id=c2] button") as HTMLElement;
    fireEvent.pointerDown(filed, { button: 0, clientX: 10, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 410 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 410 });
    fireEvent.click(document.body);
    expect(api.updateWorkspace).toHaveBeenLastCalledWith("c2", { folderId: null });
  });

  it("Move to Folder lists the folders that fit, and New Folder creates one to rename", async () => {
    const { container } = renderSidebar();
    fireEvent.contextMenu(container.querySelector("[data-chat-id=c4]") as HTMLElement);
    const trigger = screen.getByRole("menuitem", { name: "Move to Folder" });
    fireEvent.click(trigger);
    const work = await screen.findByRole("menuitemradio", { name: "Work" });
    expect(screen.queryByRole("menuitemradio", { name: "Bugs" })).toBeNull();
    fireEvent.click(work);
    expect(api.updateWorkspace).toHaveBeenCalledWith("c4", { folderId: "F" });
  });

  it("New Folder in the Projects header creates a folder and edits its name", async () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "New Folder" }));
    await waitFor(() => expect(api.createFolder).toHaveBeenCalledWith({ name: "New Folder", projectId: null }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Folder name" })).toBeTruthy());
  });

  it("deleting a folder asks first", async () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Work" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete Folder…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteFolder).toHaveBeenCalledWith("F"));
  });
});
