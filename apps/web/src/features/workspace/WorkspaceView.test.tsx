/** Workspace tabs (I-036): main tabs, sub-agent pane, new/close/switch, maximize, saved layout. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSettings, type WorkspaceLayout } from "@pi-ui/protocol";
import { ConfirmHost, TooltipProvider } from "@/ui";
import { models, projects, sessions, settings, workspaces } from "@/state/store";
import { getChatSession, resetChatSessions } from "@/state/chat-session";
import { makeProject, makeSession, makeWorkspace } from "@/test/fixtures";
import { ChatRoute } from "@/app/RouteViews";
import { maximizedGroup } from "./layout-actions";

vi.mock("@/lib/api", () => ({
  api: {
    getSession: vi.fn(() => new Promise(() => {})),
    listCommands: vi.fn(() => new Promise(() => {})),
    updateWorkspace: vi.fn(async (id: string, patch: { layout?: WorkspaceLayout }) => ({
      ...workspaces.value.find((w) => w.id === id),
      ...patch,
    })),
    updateSession: vi.fn(async (id: string, patch: object) => ({ ...sessions.value.find((s) => s.id === id), ...patch })),
    createSession: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
    deleteWorkspace: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));
const { api } = await import("@/lib/api");

Element.prototype.scrollTo ??= function () {};

function renderAt(url: string) {
  const router = createMemoryRouter(
    [
      { path: "/projects/:projectId/chats/:chatId", element: <ChatRoute /> },
      { path: "/projects/:projectId", element: <div>New chat screen</div> },
    ],
    { initialEntries: [url] },
  );
  render(
    <TooltipProvider>
      <RouterProvider router={router} />
      <ConfirmHost />
    </TooltipProvider>,
  );
  return router;
}

const mainTabs = () => within(screen.getByRole("tablist", { name: "Conversations" })).getAllByRole("tab");
const subTablist = () => screen.queryByRole("tablist", { name: "Sub-agents" });

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
  maximizedGroup.value = {};
  settings.value = defaultSettings();
  models.value = [];
  projects.value = [makeProject({ id: "p" })];
  workspaces.value = [makeWorkspace({ id: "w", projectId: "p", title: "Workspace" })];
  sessions.value = [
    makeSession({ id: "m1", workspaceId: "w", title: "Fix login", createdAt: 1, status: "working" }),
    makeSession({ id: "m2", workspaceId: "w", title: "Tab 2", createdAt: 2 }),
    makeSession({ id: "a1", workspaceId: "w", kind: "subagent", parentSessionId: "m1", agentName: "reviewer", title: "reviewer", createdAt: 3 }),
    makeSession({ id: "a2", workspaceId: "w", kind: "subagent", parentSessionId: "m1", agentName: "tests", title: "tests", createdAt: 4, status: "unread" }),
  ];
});

describe("WorkspaceView", () => {
  it("shows main tabs with status and the active tab's sub-agents on the right", () => {
    renderAt("/projects/p/chats/w");
    expect(mainTabs().map((t) => t.textContent)).toEqual(["Fix login", "Tab 2"]);
    expect(mainTabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(mainTabs()[0]!.querySelector('[data-status="working"]')).not.toBeNull();
    const subs = within(subTablist()!).getAllByRole("tab");
    expect(subs.map((t) => t.textContent)).toEqual(["reviewer", "tests"]);
    expect(subs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("separator", { name: "Resize sub-agents" })).toBeTruthy();
  });

  it("hides the sub-agent pane for a tab without sub-agents; switching updates ?tab= and the saved layout", async () => {
    const router = renderAt("/projects/p/chats/w");
    fireEvent.click(mainTabs()[1]!);
    await waitFor(() => expect(router.state.location.search).toBe("?tab=m2"));
    expect(mainTabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(subTablist()).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize sub-agents" })).toBeNull();
    expect(api.updateWorkspace).toHaveBeenCalledWith("w", { layout: { activeMainSessionId: "m2" } });
  });

  it("remembers the focused sub-agent per main tab", async () => {
    renderAt("/projects/p/chats/w");
    fireEvent.click(within(subTablist()!).getByRole("tab", { name: /tests/ }));
    await waitFor(() => expect(within(subTablist()!).getByRole("tab", { name: /tests/ }).getAttribute("aria-selected")).toBe("true"));
    expect(api.updateWorkspace).toHaveBeenCalledWith("w", { layout: { activeSubagentSessionId: { m1: "a2" } } });
  });

  it("opens a new tab with + and focuses it", async () => {
    const created = makeSession({ id: "m3", workspaceId: "w", title: "New chat", createdAt: 5 });
    vi.mocked(api.createSession).mockResolvedValueOnce({
      session: created,
      transcript: { messages: [], toolResults: {} },
      state: getChatSession("m3").state.value,
      pendingUiRequests: [],
    });
    const router = renderAt("/projects/p/chats/w");
    fireEvent.click(screen.getByRole("button", { name: /New Tab/ }));
    await waitFor(() => expect(router.state.location.search).toBe("?tab=m3"));
    expect(api.createSession).toHaveBeenCalledWith("w", {});
    expect(mainTabs().map((t) => t.textContent)).toEqual(["Fix login", "Tab 2", "New chat"]);
    expect(api.updateWorkspace).toHaveBeenCalledWith("w", { layout: { mainOrder: ["m1", "m2", "m3"], activeMainSessionId: "m3" } });
  });

  it("closes a tab (asking when it has history) and focuses its neighbour", async () => {
    sessions.value = sessions.value.map((s) => (s.id === "m1" ? { ...s, lastActivityAt: 10, status: "idle" } : s));
    const router = renderAt("/projects/p/chats/w");
    fireEvent.click(screen.getByRole("button", { name: "Close Fix login" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("its 2 sub-agents");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close Tab" }));
    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith("m1"));
    await waitFor(() => expect(router.state.location.search).toBe("?tab=m2"));
    expect(mainTabs().map((t) => t.textContent)).toEqual(["Tab 2"]);
    expect(subTablist()).toBeNull();
  });

  it("closing the last tab asks, then deletes the whole chat and leaves for the project (I-061)", async () => {
    sessions.value = sessions.value.filter((s) => s.id === "m2");
    const router = renderAt("/projects/p/chats/w");
    fireEvent.click(screen.getByRole("button", { name: "Close Tab 2" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete “Workspace”?");
    expect(dialog.textContent).toContain("This is the last tab, so the whole chat will be deleted.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Chat" }));
    await waitFor(() => expect(api.deleteWorkspace).toHaveBeenCalledWith("w"));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/p"));
    expect(api.deleteSession).not.toHaveBeenCalled();
    expect(workspaces.value).toEqual([]);
  });

  it("cancelling the last-tab confirm keeps the chat; ⌘W asks the same", async () => {
    sessions.value = sessions.value.filter((s) => s.id === "m2");
    const router = renderAt("/projects/p/chats/w");
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("This is the last tab");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.deleteWorkspace).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/projects/p/chats/w");
    expect(mainTabs().map((t) => t.textContent)).toEqual(["Tab 2"]);
  });

  it("closes an empty tab without asking", async () => {
    renderAt("/projects/p/chats/w?tab=m2");
    fireEvent.click(screen.getByRole("button", { name: "Close Tab 2" }));
    await waitFor(() => expect(api.deleteSession).toHaveBeenCalledWith("m2"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("double-clicking a tab maximizes its group, again restores", async () => {
    renderAt("/projects/p/chats/w");
    fireEvent.dblClick(within(subTablist()!).getAllByRole("tab")[0]!);
    await waitFor(() => expect(screen.queryByRole("tablist", { name: "Conversations" })).toBeNull());
    fireEvent.dblClick(within(subTablist()!).getAllByRole("tab")[0]!);
    await waitFor(() => expect(screen.getByRole("tablist", { name: "Conversations" })).toBeTruthy());
    fireEvent.dblClick(mainTabs()[0]!);
    await waitFor(() => expect(subTablist()).toBeNull());
  });

  it("⌃Tab / ⌃⇧Tab cycle the main tabs", async () => {
    const router = renderAt("/projects/p/chats/w");
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
    await waitFor(() => expect(router.state.location.search).toBe("?tab=m2"));
    fireEvent.keyDown(window, { key: "Tab", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(router.state.location.search).toBe("?tab=m1"));
  });

  it("renames a tab inline from its context menu", async () => {
    renderAt("/projects/p/chats/w?tab=m2");
    fireEvent.contextMenu(mainTabs()[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    const input = (await screen.findByRole("textbox", { name: "Tab title" })) as HTMLInputElement;
    input.value = "Docs";
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("m2", { title: "Docs" }));
  });

  it("sub-agent tabs show done ✓ with the result, and a closed agent's tab just disappears (I-054/I-055)", () => {
    const agentState = { agent: null, task: "review", keepOpenReason: null, userEngaged: false, closing: false, doneAt: 1 };
    sessions.value = sessions.value.map((s) =>
      s.id === "a1" ? { ...s, agent: { ...agentState, status: "done" as const, result: "Looks good." } } : s.id === "a2" ? { ...s, agent: { ...agentState, status: "working" as const, doneAt: null, result: null } } : s,
    );
    renderAt("/projects/p/chats/w");
    const [reviewer, tests] = within(subTablist()!).getAllByRole("tab");
    expect(reviewer!.querySelector('[aria-label="Done"]')).not.toBeNull();
    expect(reviewer!.getAttribute("title")).toContain("Result: Looks good.");
    expect(tests!.querySelector('[aria-label="Done"]')).toBeNull();
    expect(document.querySelector('[data-agent-bar="done"]')!.textContent).toContain("Looks good.");

    // The server deletes an agent once it closes (session_removed): its tab goes away.
    sessions.value = sessions.value.filter((s) => s.id !== "a1");
    return waitFor(() => expect(within(subTablist()!).getAllByRole("tab").map((t) => t.textContent)).toEqual(["tests"]));
  });
});
