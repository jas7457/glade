import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/api", () => ({ api: { reorderProjects: vi.fn(async () => []), reorderPinnedChats: vi.fn(async () => []) } }));

import { api } from "@/lib/api";
import { TooltipProvider, sidebarClass } from "@/ui";
import { chats, projects } from "@/state/store";
import { closedProjects } from "@/state/ui";
import { makeChat, makeProject } from "@/test/fixtures";
import { Sidebar } from "./Sidebar";
import { visibleChatCount } from "./ChatList";
import { formatRelativeTime } from "./time";

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
    chats.value = [
      makeChat({ id: "c1", projectId: "p1", title: "Old", createdAt: 1, lastActivityAt: 9 }),
      makeChat({ id: "c2", projectId: "p1", title: "Newer", createdAt: 3, lastActivityAt: 3, status: "working", running: true }),
      makeChat({ id: "c3", projectId: "p1", title: "Pinned", lastActivityAt: 0, pinned: true, pinOrder: 0, status: "unread", unread: true }),
      makeChat({ id: "c4", projectId: null, title: "Loose", lastActivityAt: 2, status: "blocked", pendingInputs: 1 }),
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

  it("offers Move Up / Move Down in the project menu, not Pin", () => {
    const { container } = renderSidebar();
    const beta = container.querySelector("[data-project-id=p2] [data-sort-id]") ?? container.querySelector("[data-project-id=p2]");
    const row = within(beta as HTMLElement).getByRole("button", { name: "Beta" });
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Move Up" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Move Down" }));
    expect(api.reorderProjects).toHaveBeenCalledWith(["p1", "p2"]);
    expect(projectOrder(container)).toEqual(["p1", "p2"]);
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

    it("reorders pinned chats within their list; unpinned chats aren't draggable", () => {
      chats.value = [
        ...chats.value,
        makeChat({ id: "c5", projectId: "p1", title: "Pinned two", pinned: true, pinOrder: 1 }),
      ];
      const { container } = renderSidebar();
      layout();
      const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
      expect(rowTitles(alpha)).toEqual(["c3", "c5", "c2", "c1"]);
      expect(alpha.querySelectorAll("[data-sort-group^='pins:']")).toHaveLength(2);
      const row = alpha.querySelector("[data-chat-id=c5] button") as HTMLElement;
      fireEvent.pointerDown(row, { button: 0, clientX: 10, clientY: 40 });
      fireEvent.pointerMove(window, { clientX: 10, clientY: 2 });
      fireEvent.pointerUp(window, { clientX: 10, clientY: 2 });
      fireEvent.click(row);
      expect(api.reorderPinnedChats).toHaveBeenCalledWith("p1", ["c5", "c3"]);
      expect(rowTitles(alpha)).toEqual(["c5", "c3", "c2", "c1"]);

      // Unpinned rows don't start a drag.
      fireEvent.pointerDown(alpha.querySelector("[data-chat-id=c2] button") as HTMLElement, { button: 0, clientX: 10, clientY: 70 });
      fireEvent.pointerMove(window, { clientX: 10, clientY: 2 });
      expect(container.querySelector("[data-drop-line]")).toBeNull();
      fireEvent.pointerUp(window, { clientX: 10, clientY: 2 });
      expect(api.reorderPinnedChats).toHaveBeenCalledTimes(1);
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

  it("shows the status left of the title, outside the area hover actions replace, on every row", () => {
    const { container } = renderSidebar();
    for (const id of ["c1", "c2", "c3", "c4"]) {
      const row = container.querySelector(`[data-chat-id=${id}]`) as HTMLElement;
      // Every chat row reserves the leading slot (empty when idle) so titles line up.
      const leading = row.querySelector("[data-slot=leading]") as HTMLElement;
      expect(leading).toBeTruthy();
      expect(row.querySelector("[data-slot=trailing] [data-status]")).toBeNull();
    }
    const working = container.querySelector("[data-chat-id=c2] [data-slot=leading]") as HTMLElement;
    expect(within(working).getByRole("img", { name: "Working…" })).toBeTruthy();
    const title = within(container.querySelector("[data-chat-id=c2]") as HTMLElement).getByText("Newer");
    expect(working.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("lines up with the sidebar grid: status column, project icon indent, chat titles", () => {
    const { container } = renderSidebar();
    const button = (sel: string) => container.querySelector(`${sel} button`) as HTMLElement;
    // Project row content at indent 1; its chats' titles at indent 2 (aligned with the name).
    expect(within(container.querySelector("[data-project-id=p1]") as HTMLElement).getByRole("button", { name: "Alpha" }).className).toContain(
      sidebarClass.inset[1],
    );
    expect(button("[data-chat-id=c1]").className).toContain(sidebarClass.inset[2]);
    // Standalone chats: title right after the status column.
    expect(button("[data-chat-id=c4]").className).toContain(sidebarClass.inset[1]);
    // Status sits in column 0 for both.
    for (const id of ["c1", "c4"]) {
      expect((container.querySelector(`[data-chat-id=${id}] [data-slot=leading]`) as HTMLElement).className).toContain(sidebarClass.status);
    }
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
    expect(closedProjects.value.has("p1")).toBe(true);
  });

  it("limits long project lists with Show more", () => {
    chats.value = Array.from({ length: 8 }, (_, i) => makeChat({ id: `x${i}`, projectId: "p1", lastActivityAt: i }));
    const { container } = renderSidebar();
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    expect(rowTitles(alpha)).toHaveLength(5);
    fireEvent.click(within(alpha).getByText("Show more (3)"));
    expect(rowTitles(alpha)).toHaveLength(8);
  });
});

describe("visibleChatCount", () => {
  const list = Array.from({ length: 8 }, (_, i) => makeChat({ id: `c${i}` }));
  it("shows the limit, all when expanded, and reaches the selection", () => {
    expect(visibleChatCount(list, 5, false, null)).toBe(5);
    expect(visibleChatCount(list, 5, true, null)).toBe(8);
    expect(visibleChatCount(list, 5, false, "c6")).toBe(7);
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
