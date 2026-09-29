import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { MemoryRouter } from "react-router";
import { connections } from "@glade/app-core/state/env-registry";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { projects, workspaces } from "@glade/app-core/state/store";
import { closedProjects } from "@glade/app-core/state/ui";
import { makeProject, makeWorkspace } from "@glade/app-core/test/fixtures";
import { fakeEnv } from "~/test/fake-env";
import { ChatList, PHONE_PROJECT_LIMIT } from "./ChatList";
import { chatGroups, matchesQuery } from "./chat-groups";

const ids = (el: Element) => [...el.querySelectorAll("[data-chat-id]")].map((e) => e.getAttribute("data-chat-id"));

function renderList(props: Partial<Parameters<typeof ChatList>[0]> = {}) {
  const onOpen = vi.fn();
  const onOpenDevice = vi.fn();
  const utils = render(
    <MemoryRouter>
      <ChatList onOpen={onOpen} onOpenDevice={onOpenDevice} {...props} />
    </MemoryRouter>,
  );
  return { ...utils, onOpen, onOpenDevice };
}

describe("iPhone chat list", () => {
  beforeEach(() => {
    closedProjects.value = new Set();
    connections.value = [fakeEnv("m1", "Studio")];
    savedEnvironments.value = [{ id: "m1", name: "Studio", urls: ["http://m1.test:4327"], token: "t" }];
    projects.value = [
      makeProject({ id: "p1", name: "Alpha", sortOrder: 1, environmentId: "m1" }),
      makeProject({ id: "p2", name: "Beta", sortOrder: 0, environmentId: "m1" }),
    ];
    workspaces.value = [
      makeWorkspace({ id: "c1", projectId: "p1", title: "Fix the build", createdAt: 1, environmentId: "m1" }),
      makeWorkspace({ id: "c2", projectId: "p1", title: "Write docs", createdAt: 3, status: "working", running: true, environmentId: "m1" }),
      makeWorkspace({ id: "c3", projectId: "p1", title: "Pinned one", pinned: true, pinOrder: 0, status: "unread", unread: true, environmentId: "m1" }),
      makeWorkspace({ id: "c4", projectId: null, title: "Loose question", status: "blocked", pendingInputs: 1, environmentId: "m1" }),
    ];
  });

  it("groups by project in manual order, pinned first, then the standalone chats", () => {
    const { container } = renderList();
    const sections = [...container.querySelectorAll("section[aria-label]")].map((s) => s.getAttribute("aria-label"));
    expect(sections).toEqual(["Beta", "Alpha", "Chats"]);
    expect(ids(container.querySelector("[data-project-id=p1]")!)).toEqual(["c3", "c2", "c1"]);
    expect(within(container.querySelector("[data-project-id=p2]") as HTMLElement).getByText("No chats")).toBeTruthy();
    expect(screen.getByLabelText("Pinned")).toBeTruthy();
    // Status: working, unread, needs you.
    expect(screen.getByRole("img", { name: "New messages" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Needs your input" })).toBeTruthy();
  });

  it("filters by title and hides groups without matches", () => {
    const { container, rerender, onOpen } = renderList({ query: "build" });
    expect(ids(container)).toEqual(["c1"]);
    expect(container.querySelector("[data-project-id=p2]")).toBeNull();
    fireEvent.click(screen.getByText("Fix the build"));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
    rerender(
      <MemoryRouter>
        <ChatList onOpen={onOpen} query="nothing like this" />
      </MemoryRouter>,
    );
    expect(screen.getByText(/No chats match/)).toBeTruthy();
    expect(matchesQuery("Fix the build", "the FIX")).toBe(true);
    expect(chatGroups("loose").map((g) => g.kind)).toEqual(["standalone"]);
  });

  it("collapses a project and shows its most urgent status", () => {
    const { container } = renderList();
    fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
    expect(ids(container.querySelector("[data-project-id=p1]")!)).toEqual([]);
    expect(closedProjects.value.has("p1")).toBe(true);
    expect(within(container.querySelector("[data-project-id=p1]") as HTMLElement).getByRole("img", { name: "Working…" })).toBeTruthy();
  });

  it("limits long projects with Show More", () => {
    workspaces.value = Array.from({ length: PHONE_PROJECT_LIMIT + 2 }, (_, i) => makeWorkspace({ id: `w${i}`, projectId: "p2", createdAt: i, environmentId: "m1" }));
    const { container } = renderList();
    expect(ids(container)).toHaveLength(PHONE_PROJECT_LIMIT);
    fireEvent.click(screen.getByRole("button", { name: "Show 2 More" }));
    expect(ids(container)).toHaveLength(PHONE_PROJECT_LIMIT + 2);
  });

  it("marks the Mac when more than one is connected, and lists Macs that are down", () => {
    connections.value = [fakeEnv("m1", "Studio"), fakeEnv("m2", "MacBook Air", "offline")];
    savedEnvironments.value = [...savedEnvironments.value, { id: "m2", name: "MacBook Air", urls: ["http://m2.test:4327"], token: "t" }];
    const { container, onOpenDevice } = renderList();
    const alpha = container.querySelector("[data-project-id=p1]") as HTMLElement;
    expect(within(alpha).getByTitle("Studio")).toBeTruthy();
    const down = container.querySelector("[data-down-environment=m2]") as HTMLElement;
    expect(down.textContent).toContain("Can't reach MacBook Air");
    fireEvent.click(down);
    expect(onOpenDevice).toHaveBeenCalledWith("m2");
  });

  it("shows an empty state with a way to start a chat", () => {
    projects.value = [];
    workspaces.value = [];
    const onNewChat = vi.fn();
    renderList({ onNewChat });
    expect(screen.getByText("No chats yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start a Chat" }));
    expect(onNewChat).toHaveBeenCalled();
  });

  it("says chats come back once the Mac is connected when every Mac is down", () => {
    connections.value = [fakeEnv("m1", "Studio", "offline")];
    projects.value = [];
    workspaces.value = [];
    renderList();
    expect(screen.getByText("Can't reach Studio")).toBeTruthy();
    expect(screen.queryByText("No chats yet")).toBeNull();
    expect(screen.getByText(/once your Mac is connected/)).toBeTruthy();
  });

  it("opens a chat's actions on long-press (context menu)", () => {
    renderList();
    fireEvent.contextMenu(screen.getByText("Fix the build"));
    expect(screen.getByRole("dialog", { name: "Fix the build" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pin" })).toBeTruthy();
  });
});
