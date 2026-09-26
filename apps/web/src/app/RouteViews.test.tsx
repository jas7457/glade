/** `/chats/:id` resolves a workspace and its tab (`?tab=`), keeping the URL canonical. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";

vi.mock("@/features/chat", () => ({
  ChatView: ({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) => <div>{`view ${workspaceId}/${sessionId}`}</div>,
  NewChatView: () => <div>new chat</div>,
}));

import { projects, sessions, workspaces } from "@/state/store";
import { makeProject, makeSession, makeWorkspace } from "@/test/fixtures";
import { ChatRoute } from "./RouteViews";

function renderAt(url: string) {
  const router = createMemoryRouter(
    [
      { path: "/chats/:chatId", element: <ChatRoute /> },
      { path: "/projects/:projectId/chats/:chatId", element: <ChatRoute /> },
    ],
    { initialEntries: [url] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  projects.value = [makeProject({ id: "p" })];
  workspaces.value = [makeWorkspace({ id: "w", projectId: "p" })];
  sessions.value = [
    makeSession({ id: "s1", workspaceId: "w", createdAt: 1 }),
    makeSession({ id: "s2", workspaceId: "w", createdAt: 2 }),
  ];
});

describe("ChatRoute", () => {
  it("shows the workspace's first main session by default", () => {
    renderAt("/projects/p/chats/w");
    expect(screen.getByText("view w/s1")).toBeTruthy();
  });

  it("shows the tab from ?tab= so a refresh restores it", () => {
    const router = renderAt("/projects/p/chats/w?tab=s2");
    expect(screen.getByText("view w/s2")).toBeTruthy();
    expect(router.state.location.search).toBe("?tab=s2");
  });

  it("redirects to the canonical path (project, valid tab)", () => {
    const router = renderAt("/chats/w?tab=s2");
    expect(router.state.location.pathname).toBe("/projects/p/chats/w");
    expect(router.state.location.search).toBe("?tab=s2");
    const stale = renderAt("/projects/p/chats/w?tab=gone");
    expect(stale.state.location.search).toBe("");
    expect(screen.getAllByText("view w/s1").length).toBeGreaterThan(0);
  });

  it("says not found for unknown workspaces", () => {
    renderAt("/chats/nope");
    expect(screen.getByText("Chat not found")).toBeTruthy();
  });
});
