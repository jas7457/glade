import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { MemoryRouter } from "react-router";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    reorderProjects: vi.fn(async () => []),
    reorderPinnedWorkspaces: vi.fn(async () => []),
    reorderChatList: vi.fn(async () => ({ workspaces: [], folders: [] })),
    updateSession: vi.fn(async (id: string, patch: object) => ({ ...sessions.value.find((s) => s.id === id), ...patch })),
  },
}));

import { api } from "@glade/app-core/lib/api";
import { TooltipProvider, sidebarClass } from "@glade/app-core/ui";
import { projects, sessions, workspaces } from "@glade/app-core/state/store";
import { closedProjects } from "@glade/app-core/state/ui";
import { makeProject, makeSession, makeWorkspace } from "@glade/app-core/test/fixtures";
import { Sidebar } from "./Sidebar";
import { formatRelativeTime } from "@glade/app-core/features/sidebar/time";

function renderSidebar(path = "/") {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <Sidebar />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

const projectOrder = (container: Element) =>
  [...container.querySelectorAll("[data-project-id]")].map((el) => el.getAttribute("data-project-id"));
const rowTitles = (container: HTMLElement) => [...container.querySelectorAll("[data-chat-id]")].map((el) => el.getAttribute("data-chat-id"));

describe("Sidebar", () => {
  beforeEach(() => {
    closedProjects.value = new Set();
    vi.clearAllMocks();
    projects.value = [
      makeProject({ id: "p1", name: "Alpha", sortOrder: 1, lastActivityAt: 10 }),
      makeProject({ id: "p2", name: "Beta", sortOrder: 0, lastActivityAt: 5 }),
    ];
    workspaces.value = [
      makeWorkspace({ id: "c1", projectId: "p1", title: "Old", createdAt: 1, lastActivityAt: 9 }),
      makeWorkspace({ id: "c2", projectId: "p1", title: "Newer", createdAt: 3, lastActivityAt: 3, status: "working", running: true }),
      makeWorkspace({ id: "c3", projectId: "p1", title: "Pinned", lastActivityAt: 0, pinned: true, pinOrder: 0, status: "unread", unread: true }),
      makeWorkspace({ id: "c4", projectId: null, title: "Loose", lastActivityAt: 2, status: "blocked", pendingInputs: 1 }),
    ];
  });

  it("lists projects in manual order, and chats pinned-first then newest-created first", () => {
    const { container } = renderSidebar();
    expect(projectOrder(container)).toEqual(["p2", "p1"]);
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    expect(rowTitles(alpha)).toEqual(["c3", "c2", "c1"]);
    expect(screen.getByText("Loose")).toBeTruthy();
  });

  it("separates pinned from unpinned chats with a divider", () => {
    const { container } = renderSidebar();
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    const dividers = alpha.querySelectorAll("[data-pinned-divider]");
    expect(dividers).toHaveLength(1);
    expect(dividers[0]?.closest("[role=listitem]")?.querySelector("[data-chat-id]")?.getAttribute("data-chat-id")).toBe("c3");
    // No divider when there's nothing pinned.
    expect(container.querySelector("[data-project-id=p2] [data-pinned-divider]")).toBeNull();
  });

  it("has no Move Up / Move Down (or Pin) in the project and chat menus: ordering is by dragging (I-202)", () => {
    const { container } = renderSidebar();
    fireEvent.contextMenu(within(container.querySelector("[data-project-id=p2]") as HTMLElement).getByRole("button", { name: "Beta" }));
    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Move Up" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Move Down" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Move to Folder" })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    fireEvent.contextMenu(container.querySelector("[data-chat-id=c3]") as HTMLElement);
    expect(screen.queryByRole("menuitem", { name: "Move Up" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Move Down" })).toBeNull();
  });

  it("toggles Mark as Unread / Mark as Read in a chat's menu (I-073)", () => {
    sessions.value = [
      makeSession({ id: "c1a", workspaceId: "c1", createdAt: 1 }),
      makeSession({ id: "c1b", workspaceId: "c1", createdAt: 2 }),
      makeSession({ id: "c3", workspaceId: "c3", unread: true, status: "unread" }),
    ];
    workspaces.value = workspaces.value.map((w) => (w.id === "c1" ? { ...w, layout: { activeMainSessionId: "c1b" } } : w));
    const { container } = renderSidebar();
    const row = (id: string) => container.querySelector(`[data-chat-id=${id}]`) as HTMLElement;
    fireEvent.contextMenu(row("c1"));
    expect(screen.queryByRole("menuitem", { name: "Mark as Read" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark as Unread" }));
    expect(api.updateSession).toHaveBeenCalledWith("c1b", { unread: true });

    fireEvent.contextMenu(row("c3"));
    expect(screen.queryByRole("menuitem", { name: "Mark as Unread" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark as Read" }));
    expect(api.updateSession).toHaveBeenCalledWith("c3", { unread: false });
  });

  describe("drag and drop", () => {
    // jsdom has no layout: give each sortable item a 30px-high box in DOM order.
    const layout = () => {
      const els = [...document.querySelectorAll<HTMLElement>("[data-sort-group]")];
      const groups = new Map<string, number>();
      for (const el of els) {
        const g = el.dataset.sortGroup as string;
        const i = groups.get(g) ?? 0;
        groups.set(g, i + 1);
        el.getBoundingClientRect = () => ({ top: i * 32, bottom: i * 32 + 30, left: 0, right: 200, height: 30, width: 200, x: 0, y: i * 32, toJSON() {} });
      }
    };
    const rowOf = (container: Element, name: string) => within(container as HTMLElement).getByRole("button", { name });

    it("moves a project below another after passing the threshold, with an insertion line", () => {
      const { container } = renderSidebar();
      layout();
      const beta = rowOf(container, "Beta");
      fireEvent.pointerDown(beta, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 10, clientY: 12 }); // below threshold
      expect(container.querySelector("[data-drop-line]")).toBeNull();
      fireEvent.pointerMove(window, { clientX: 10, clientY: 55 });
      expect(container.querySelector("[data-project-id=p1] [data-drop-line=bottom]")).toBeTruthy();
      expect(container.querySelector("[data-project-id=p2]")?.className).toContain("opacity-40");
      fireEvent.pointerUp(window, { clientX: 10, clientY: 55 });
      fireEvent.click(beta); // the click ending a drag is swallowed
      expect(closedProjects.value.has("p2")).toBe(false);
      expect(api.reorderProjects).toHaveBeenCalledWith(["p1", "p2"]);
      expect(projectOrder(container)).toEqual(["p1", "p2"]);
      expect(container.querySelector("[data-drop-line]")).toBeNull();
    });

    it("a click without movement still toggles the project", () => {
      const { container } = renderSidebar();
      layout();
      const alpha = rowOf(container, "Alpha");
      fireEvent.pointerDown(alpha, { button: 0, clientX: 10, clientY: 40 });
      fireEvent.pointerUp(window, { clientX: 10, clientY: 40 });
      fireEvent.click(alpha);
      expect(closedProjects.value.has("p1")).toBe(true);
      expect(api.reorderProjects).not.toHaveBeenCalled();
    });

    it("Escape cancels the drag", () => {
      const { container } = renderSidebar();
      layout();
      const beta = rowOf(container, "Beta");
      fireEvent.pointerDown(beta, { button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { clientX: 10, clientY: 55 });
      expect(container.querySelector("[data-drop-line]")).toBeTruthy();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(container.querySelector("[data-drop-line]")).toBeNull();
      fireEvent.pointerUp(window, { clientX: 10, clientY: 55 });
      fireEvent.click(beta);
      expect(closedProjects.value.has("p2")).toBe(false);
      expect(api.reorderProjects).not.toHaveBeenCalled();
      expect(projectOrder(container)).toEqual(["p2", "p1"]);
    });

    it("reorders pinned chats within their list, and the other chats below them (I-202)", () => {
      workspaces.value = [
        ...workspaces.value,
        makeWorkspace({ id: "c5", projectId: "p1", title: "Pinned two", pinned: true, pinOrder: 1 }),
      ];
      const { container } = renderSidebar();
      layout();
      const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
      // The project group is its chats' drag area (the fake layout gives it one row's box).
      alpha.getBoundingClientRect = () => ({ top: 0, bottom: 500, left: 0, right: 200, height: 500, width: 200, x: 0, y: 0, toJSON() {} });
      expect(rowTitles(alpha)).toEqual(["c3", "c5", "c2", "c1"]);
      expect(alpha.querySelectorAll("[data-sort-group^='pins:']")).toHaveLength(2);
      const row = alpha.querySelector("[data-chat-id=c5] button") as HTMLElement;
      fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 40 });
      fireEvent.pointerMove(window, { clientX: 10, clientY: 2 });
      // The ghost copy follows the pointer.
      expect(document.querySelector("[data-drag-ghost] [data-chat-id]")).toBeNull();
      expect(document.querySelector("[data-drag-ghost]")?.textContent).toContain("Pinned two");
      fireEvent.pointerUp(window, { clientX: 10, clientY: 2 });
      fireEvent.click(row);
      expect(document.querySelector("[data-drag-ghost]")).toBeNull();
      expect(api.reorderPinnedWorkspaces).toHaveBeenCalledWith("p1", ["c5", "c3"]);
      expect(rowTitles(alpha)).toEqual(["c5", "c3", "c2", "c1"]);

      // Unpinned rows reorder in the list's own order, below the pinned ones.
      const unpinned = alpha.querySelector("[data-chat-id=c1] button") as HTMLElement;
      fireEvent.pointerDown(unpinned, { button: 0, clientX: 10, clientY: 40 });
      fireEvent.pointerMove(window, { clientX: 10, clientY: 2 });
      expect(alpha.querySelector("[data-chat-id=c2]")?.closest("[role=listitem]")?.querySelector("[data-drop-line=top]")).toBeTruthy();
      // Rows after the line slide down to open the gap.
      expect(alpha.querySelector("[data-chat-id=c2]")?.closest("[role=listitem]")?.className).toContain(sidebarClass.dropShift);
      fireEvent.pointerUp(window, { clientX: 10, clientY: 2 });
      fireEvent.click(unpinned);
      expect(api.reorderChatList).toHaveBeenCalledWith({ projectId: "p1", folderId: null, ids: ["c1", "c2"] });
      expect(rowTitles(alpha)).toEqual(["c5", "c3", "c1", "c2"]);
    });

    it("outside its own project a drag shows nothing and doesn't drop (not allowed)", () => {
      const { container } = renderSidebar();
      layout();
      const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
      alpha.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 200, height: 100, width: 200, x: 0, y: 0, toJSON() {} });
      const unpinned = alpha.querySelector("[data-chat-id=c1] button") as HTMLElement;
      fireEvent.pointerDown(unpinned, { button: 0, clientX: 10, clientY: 40 });
      fireEvent.pointerMove(window, { clientX: 10, clientY: 300 });
      expect(container.querySelector("[data-drop-line]")).toBeNull();
      expect(document.querySelector("[data-drag-ghost]")?.hasAttribute("data-not-allowed")).toBe(true);
      expect(document.documentElement.style.cursor).toBe("not-allowed");
      fireEvent.pointerUp(window, { clientX: 10, clientY: 300 });
      fireEvent.click(unpinned);
      expect(document.documentElement.style.cursor).toBe("");
      expect(api.reorderChatList).not.toHaveBeenCalled();
    });
  });

  it("shows status indicators per chat", () => {
    const { container } = renderSidebar();
    const row = (id: string) => container.querySelector(`[data-chat-id=${id}]`) as HTMLElement;
    expect(within(row("c2")).getByRole("img", { name: "Working…" })).toBeTruthy();
    expect(within(row("c3")).getByRole("img", { name: "New messages" })).toBeTruthy();
    expect(within(row("c4")).getByRole("img", { name: "Needs your input" })).toBeTruthy();
    expect(within(row("c1")).queryByRole("img", { name: /Working|New|Needs/ })).toBeNull();
  });

  it("shows the status on the right, in the area hover actions replace, instead of the age", () => {
    const { container } = renderSidebar();
    for (const id of ["c2", "c3", "c4"]) {
      const trailing = container.querySelector(`[data-chat-id=${id}] [data-slot=trailing]`) as HTMLElement;
      expect(trailing.querySelector("[data-status]")).toBeTruthy();
      expect(trailing.className).toContain("group-hover/item:invisible");
    }
    const working = container.querySelector("[data-chat-id=c2] [data-slot=trailing]") as HTMLElement;
    expect(within(working).getByRole("img", { name: "Working…" })).toBeTruthy();
    // Idle chats show the age instead.
    const idle = container.querySelector("[data-chat-id=c1] [data-slot=trailing]") as HTMLElement;
    expect(idle.querySelector("[data-status]")).toBeNull();
    expect(idle.textContent).not.toBe("");
    expect(container.querySelector("[data-slot=leading]")).toBeNull();
  });

  it("lines up with the sidebar grid: projects and standalone chats flush, project chats under the name", () => {
    const { container } = renderSidebar();
    const button = (sel: string) => container.querySelector(`${sel} button`) as HTMLElement;
    // Project row flush with the "Projects" header; its chats' titles at indent 1 (the project name).
    expect(within(container.querySelector("[data-project-id=p1]") as HTMLElement).getByRole("button", { name: "Alpha" }).className).toContain(
      sidebarClass.inset[0],
    );
    expect(button("[data-chat-id=c1]").className).toContain(sidebarClass.inset[1]);
    // Standalone chats flush with the "Chats" header.
    expect(button("[data-chat-id=c4]").className).toContain(sidebarClass.inset[0]);
  });

  it("marks the current chat as selected", () => {
    const { container } = renderSidebar("/projects/p1/chats/c2");
    expect(container.querySelector("[data-chat-id=c2]")?.hasAttribute("data-selected")).toBe(true);
    expect(container.querySelector("[data-chat-id=c1]")?.hasAttribute("data-selected")).toBe(false);
  });

  it("collapses a project and shows its most urgent status", () => {
    const { container } = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    expect(rowTitles(alpha)).toEqual([]);
    expect(within(alpha).getByRole("img", { name: "Working…" })).toBeTruthy();
    // The rolled-up status sits on the right, like chat statuses.
    expect(alpha.querySelector("[data-slot=trailing] [data-status=working]")).toBeTruthy();
    expect(closedProjects.value.has("p1")).toBe(true);
  });

  it("limits long project lists with Show more", () => {
    workspaces.value = Array.from({ length: 8 }, (_, i) => makeWorkspace({ id: `x${i}`, projectId: "p1", lastActivityAt: i }));
    const { container } = renderSidebar();
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    expect(rowTitles(alpha)).toHaveLength(5);
    fireEvent.click(within(alpha).getByText("Show more (3)"));
    expect(rowTitles(alpha)).toHaveLength(8);
  });
});

describe("formatRelativeTime", () => {
  const now = new Date(2026, 5, 15, 12).getTime();
  it("formats compactly", () => {
    expect(formatRelativeTime(now - 10_000, now)).toBe("now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(formatRelativeTime(now - 3 * 3600_000, now)).toBe("3h");
    expect(formatRelativeTime(now - 2 * 86400_000, now)).toBe("2d");
    expect(formatRelativeTime(now - 14 * 86400_000, now)).toBe("2w");
  });
});
