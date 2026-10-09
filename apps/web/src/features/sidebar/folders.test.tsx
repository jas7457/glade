/**
 * I-165 / I-202: folders in the desktop sidebar: grouping (project folders, Chats-section folders),
 * collapsing, dragging chats onto a folder row and into / out of / within folders, dragging
 * folders, auto-expanding a closed folder, the "Move to Folder" menu, and deleting a folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { MemoryRouter, useLocation } from "react-router";
import type { Folder } from "@glade/protocol";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    reorderProjects: vi.fn(async () => []),
    reorderPinnedWorkspaces: vi.fn(async () => []),
    reorderChatList: vi.fn(async () => ({ workspaces: [], folders: [] })),
    updateProject: vi.fn(async (id: string, patch: object) => ({ ...projects.value.find((p) => p.id === id), ...patch })),
    updateWorkspace: vi.fn(async (id: string, patch: object) => ({ ...workspaces.value.find((w) => w.id === id), ...patch })),
    createFolder: vi.fn(async (body: { name: string; projectId: string | null }) => ({ id: "NEW", sortOrder: -1, createdAt: 1, ...body })),
    deleteFolder: vi.fn(async () => undefined),
    getProjectGit: vi.fn(async () => ({ isRepo: false })),
  },
}));

import { api } from "@glade/app-core/lib/api";
import { ConfirmHost, TooltipProvider } from "@glade/app-core/ui";
import { folders, projects, workspaces } from "@glade/app-core/state/store";
import { closedProjects } from "@glade/app-core/state/ui";
import { makeProject, makeWorkspace } from "@glade/app-core/test/fixtures";
import { Sidebar } from "./Sidebar";
import { renamingFolderId } from "./folder-menu";

const folder = (over: Partial<Folder> & { id: string }): Folder => ({ name: over.id, projectId: null, sortOrder: 0, createdAt: 0, ...over });

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <output data-testid="location">{pathname + search}</output>;
}

function renderSidebar() {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={["/projects/p2"]}>
        <Sidebar />
        <LocationProbe />
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
  ];
  // Alpha: c0, [Bugs: c2], c1 · Chats: c4, [Work: c3]
  folders.value = [folder({ id: "F", name: "Work", sortOrder: 1 }), folder({ id: "PF", name: "Bugs", projectId: "p1", sortOrder: 1 })];
  workspaces.value = [
    makeWorkspace({ id: "c0", projectId: "p1", title: "First", sortOrder: 0 }),
    makeWorkspace({ id: "c1", projectId: "p1", title: "Loose one", sortOrder: 2 }),
    makeWorkspace({ id: "c2", projectId: "p1", title: "Filed", folderId: "PF", sortOrder: 0, status: "working", running: true }),
    makeWorkspace({ id: "c3", projectId: null, title: "Standalone in F", folderId: "F", sortOrder: 0 }),
    makeWorkspace({ id: "c4", projectId: null, title: "Outside", sortOrder: 0 }),
  ];
});

/** Tree rows of a list, in document order, laid out 30px high, 2px apart. */
function layoutTree(container: Element, group: string): Record<string, number> {
  const tops: Record<string, number> = {};
  [...container.querySelectorAll<HTMLElement>(`[data-sort-group="${group}"]`)].forEach((el, i) => {
    tops[el.dataset.sortId!] = i * 32;
    el.getBoundingClientRect = box(i * 32);
  });
  return tops;
}
const order = (el: Element) => [...el.querySelectorAll("[data-folder-id], [data-chat-id]")].map((x) => x.getAttribute("data-folder-id") ?? x.getAttribute("data-chat-id"));
function drag(handle: HTMLElement, fromY: number, toY: number) {
  fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: fromY });
  fireEvent.pointerMove(window, { clientX: 10, clientY: toY });
}
function drop(handle: HTMLElement, y: number) {
  fireEvent.pointerUp(window, { clientX: 10, clientY: y });
  fireEvent.click(handle);
}

describe("sidebar folders (I-165, I-202)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mixes a project's chats and folders in one order; Chats-section folders hold standalone chats", () => {
    const { container } = renderSidebar();
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    expect(order(alpha)).toEqual(["c0", "PF", "c2", "c1"]);
    // Projects are never in folders; project-less folders are in the Chats section.
    expect(container.querySelector("[data-folder-id] [data-project-id]")).toBeNull();
    const chats = container.querySelector("[data-drop-area='list:standalone']") as HTMLElement;
    expect(order(chats)).toEqual(["c4", "F", "c3"]);
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

  it("dragging a chat onto a folder's row highlights it and files the chat (another list's folder doesn't take it)", () => {
    const { container } = renderSidebar();
    (container.querySelector("[data-drop-into=PF]") as HTMLElement).getBoundingClientRect = box(200);
    const row = container.querySelector("[data-chat-id=c1] button") as HTMLElement;
    drag(row, 300, 215);
    expect(container.querySelector("[data-folder-id=PF] [data-drop-target]")).toBeTruthy();
    expect(container.querySelector("[data-drop-line]")).toBeNull();
    drop(row, 215);
    expect(api.updateWorkspace).toHaveBeenCalledWith("c1", { folderId: "PF" });

    // A standalone chat can't go in a project's folder.
    const outside = container.querySelector("[data-chat-id=c4] button") as HTMLElement;
    drag(outside, 300, 215);
    expect(container.querySelector("[data-drop-target]")).toBeNull();
    drop(outside, 215);
    expect(api.updateWorkspace).toHaveBeenCalledTimes(1);
  });

  it("drags a chat into a folder at a position, and out of it (line indented to where it lands)", () => {
    const { container } = renderSidebar();
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    // Rows: c0 0, PF 32, c2 64, c1 96.
    layoutTree(container, "tree:p1");
    const c1 = alpha.querySelector("[data-chat-id=c1] button") as HTMLElement;
    // Lower half of c2 (in Bugs): the end of the folder.
    drag(c1, 100, 64 + 25);
    const line = alpha.querySelector("[data-drop-line]") as HTMLElement;
    expect(line.getAttribute("data-drop-indent")).toBe("2");
    drop(c1, 64 + 25);
    expect(api.reorderChatList).toHaveBeenLastCalledWith({ projectId: "p1", folderId: "PF", ids: ["c2", "c1"] });
    expect(order(alpha)).toEqual(["c0", "PF", "c2", "c1"]);
    expect(workspaces.value.find((w) => w.id === "c1")?.folderId).toBe("PF");

    // c2 out of the folder, to the very top of the project.
    layoutTree(container, "tree:p1");
    const c2 = alpha.querySelector("[data-chat-id=c2] button") as HTMLElement;
    drag(c2, 70, 3);
    expect((alpha.querySelector("[data-drop-line]") as HTMLElement).getAttribute("data-drop-indent")).toBe("1");
    drop(c2, 3);
    expect(api.reorderChatList).toHaveBeenLastCalledWith({ projectId: "p1", folderId: null, ids: ["c2", "c0", "PF"] });
    expect(order(alpha)).toEqual(["c2", "c0", "PF", "c1"]);
  });

  it("drags a folder between chats (with its chats), never into another folder", () => {
    const { container } = renderSidebar();
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    layoutTree(container, "tree:p1");
    const bugs = within(alpha).getByRole("button", { name: "Bugs" });
    // Below the last row: the end of the list.
    drag(bugs, 40, 140);
    drop(bugs, 140);
    expect(api.reorderChatList).toHaveBeenLastCalledWith({ projectId: "p1", folderId: null, ids: ["c0", "c1", "PF"] });
    expect(order(alpha)).toEqual(["c0", "c1", "PF", "c2"]);
  });

  it("a closed folder opens after resting on it while dragging", () => {
    vi.useFakeTimers();
    closedProjects.value = new Set(["PF"]);
    const { container } = renderSidebar();
    (container.querySelector("[data-drop-into=PF]") as HTMLElement).getBoundingClientRect = box(200);
    const row = container.querySelector("[data-chat-id=c1] button") as HTMLElement;
    drag(row, 300, 215);
    expect(closedProjects.value.has("PF")).toBe(true);
    vi.advanceTimersByTime(650);
    expect(closedProjects.value.has("PF")).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    drop(row, 215);
    expect(api.updateWorkspace).not.toHaveBeenCalled();
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

  it("every item of the chat, project and folder menus has an icon (I-168)", async () => {
    const { container } = renderSidebar();
    const expectIcons = () => {
      const items = screen.getAllByRole("menuitem").concat(screen.queryAllByRole("menuitemradio"));
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.querySelector("svg"), item.textContent ?? "").not.toBeNull();
    };
    fireEvent.contextMenu(container.querySelector("[data-chat-id=c3]") as HTMLElement);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Folder" }));
    await screen.findByRole("menuitem", { name: "Remove from Folder" });
    expectIcons();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.contextMenu(screen.getByRole("button", { name: "Alpha" }));
    expectIcons();
    // Projects never go in folders (I-202).
    expect(screen.queryByRole("menuitem", { name: "Move to Folder" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.contextMenu(screen.getByRole("button", { name: "Work" }));
    expectIcons();
  });

  it("New Folder in the Chats header creates a Chats-section folder and edits its name", async () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "New Folder" }));
    await waitFor(() => expect(api.createFolder).toHaveBeenCalledWith({ name: "New Folder", projectId: null }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Folder name" })).toBeTruthy());
  });

  it("the Chats header has New Folder, then New Chat to its right, which starts a standalone chat (I-215)", () => {
    renderSidebar();
    const folderButton = screen.getByRole("button", { name: "New Folder" });
    const chatButton = screen.getByRole("button", { name: "New Chat" });
    expect(folderButton.compareDocumentPosition(chatButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(folderButton.parentElement).toBe(chatButton.parentElement);
    fireEvent.click(chatButton);
    expect(screen.getByTestId("location").textContent).toBe("/");
  });

  it("a Chats folder's + and New Chat item open a standalone new chat for that folder (I-215)", async () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "New chat in Work" }));
    expect(screen.getByTestId("location").textContent).toBe("/?folder=F");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Work" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New Chat" }));
    expect(screen.getByTestId("location").textContent).toBe("/?folder=F");
  });

  it("a project folder's + and New Chat item open that project's new chat for the folder (I-215)", async () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "New chat in Bugs" }));
    expect(screen.getByTestId("location").textContent).toBe("/projects/p1?folder=PF");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Bugs" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New Chat" }));
    expect(screen.getByTestId("location").textContent).toBe("/projects/p1?folder=PF");
  });

  it("deleting a folder asks first", async () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Work" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete Folder…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteFolder).toHaveBeenCalledWith("F"));
  });
});
