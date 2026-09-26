import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/api", () => ({ api: {} }));

import { TooltipProvider } from "@/ui";
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

const rowTitles = (container: HTMLElement) => [...container.querySelectorAll("[data-chat-id]")].map((el) => el.getAttribute("data-chat-id"));

describe("Sidebar", () => {
  beforeEach(() => {
    closedProjects.value = new Set();
    projects.value = [
      makeProject({ id: "p1", name: "Alpha", lastActivityAt: 10 }),
      makeProject({ id: "p2", name: "Beta", lastActivityAt: 5, pinned: true }),
    ];
    chats.value = [
      makeChat({ id: "c1", projectId: "p1", title: "Old", lastActivityAt: 1 }),
      makeChat({ id: "c2", projectId: "p1", title: "Newer", lastActivityAt: 3, status: "working", running: true }),
      makeChat({ id: "c3", projectId: "p1", title: "Pinned", lastActivityAt: 0, pinned: true, status: "unread", unread: true }),
      makeChat({ id: "c4", projectId: null, title: "Loose", lastActivityAt: 2, status: "blocked", pendingInputs: 1 }),
    ];
  });

  it("lists pinned projects first, and chats pinned-first then newest-first", () => {
    const { container } = renderSidebar();
    const projectIds = [...container.querySelectorAll("[data-project-id]")].map((el) => el.getAttribute("data-project-id"));
    expect(projectIds).toEqual(["p2", "p1"]);
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    expect(rowTitles(alpha)).toEqual(["c3", "c2", "c1"]);
    expect(screen.getByText("Loose")).toBeTruthy();
  });

  it("shows status indicators per chat", () => {
    const { container } = renderSidebar();
    const row = (id: string) => container.querySelector(`[data-chat-id=${id}]`) as HTMLElement;
    expect(within(row("c2")).getByRole("img", { name: "Working…" })).toBeTruthy();
    expect(within(row("c3")).getByRole("img", { name: "New messages" })).toBeTruthy();
    expect(within(row("c4")).getByRole("img", { name: "Needs your input" })).toBeTruthy();
    expect(within(row("c1")).queryByRole("img", { name: /Working|New|Needs/ })).toBeNull();
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
