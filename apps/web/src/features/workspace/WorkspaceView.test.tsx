/** Workspace tabs (I-036): main tabs, sub-agent pane (+ strip, I-080), new/close/switch, maximize, saved layout. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSettings, formatAgentFinished, type WorkspaceLayout } from "@glade/protocol";
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
    abort: vi.fn(async () => undefined),
    generateSessionTitle: vi.fn(async () => ({ title: "Named" })),
  },
  // Changes panel (I-097) status requests.
  request: vi.fn(async () => ({ isRepo: false })),
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
  workspaces.value = [makeWorkspace({ id: "w", projectId: "p", title: "Workspace", layout: { subagentPaneOpen: true } })];
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
    expect(api.updateWorkspace).toHaveBeenCalledWith("w", { layout: { subagentPaneOpen: true, activeMainSessionId: "m2" } });
  });

  it("remembers the focused sub-agent per main tab", async () => {
    renderAt("/projects/p/chats/w");
    fireEvent.click(within(subTablist()!).getByRole("tab", { name: /tests/ }));
    await waitFor(() => expect(within(subTablist()!).getByRole("tab", { name: /tests/ }).getAttribute("aria-selected")).toBe("true"));
    expect(api.updateWorkspace).toHaveBeenCalledWith("w", { layout: { subagentPaneOpen: true, activeSubagentSessionId: { m1: "a2" } } });
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
    expect(api.createSession).toHaveBeenCalledWith("w", { harness: "fake" });
    expect(mainTabs().map((t) => t.textContent)).toEqual(["Fix login", "Tab 2", "New chat"]);
    expect(api.updateWorkspace).toHaveBeenCalledWith("w", { layout: { subagentPaneOpen: true, mainOrder: ["m1", "m2", "m3"], activeMainSessionId: "m3" } });
  });

  it("a new tab (+ / ⌘T) runs in the focused tab's agent (I-119)", async () => {
    sessions.value = sessions.value.map((s) => (s.id === "m2" ? { ...s, harness: "acp-fake" } : s));
    const created = makeSession({ id: "m3", workspaceId: "w", title: "New chat", createdAt: 5, harness: "acp-fake" });
    vi.mocked(api.createSession).mockResolvedValue({
      session: created,
      transcript: { messages: [], toolResults: {} },
      state: getChatSession("m3").state.value,
      pendingUiRequests: [],
    });
    const router = renderAt("/projects/p/chats/w?tab=m2");
    fireEvent.keyDown(window, { key: "t", metaKey: true });
    await waitFor(() => expect(router.state.location.search).toBe("?tab=m3"));
    expect(api.createSession).toHaveBeenCalledWith("w", { harness: "acp-fake" });
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
    expect(dialog.textContent).toContain("Delete chat?");
    expect(dialog.textContent).toContain("“Workspace” will be permanently deleted, since this is its last tab.");
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
    expect(dialog.textContent).toContain("since this is its last tab");
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
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const input = (await screen.findByRole("textbox", { name: "Tab title" })) as HTMLInputElement;
    input.value = "Docs";
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("m2", { title: "Docs" }));
  });

  it("renames a tab with AI from its context menu (I-101)", async () => {
    renderAt("/projects/p/chats/w?tab=m1");
    fireEvent.contextMenu(mainTabs()[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename with AI" }));
    await waitFor(() => expect(api.generateSessionTitle).toHaveBeenCalledWith("m2"));
  });

  it("the header's changes button opens the changes panel in place of the sub-agents (I-097)", async () => {
    renderAt("/projects/p/chats/w?tab=m1");
    expect(subTablist()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Changes" }));
    await waitFor(() => expect(screen.getByText("Not a git repository")).toBeTruthy());
    expect(subTablist()).toBeNull();
    expect(screen.getByRole("separator", { name: "Resize changes" })).toBeTruthy();
    await waitFor(() => expect(api.updateWorkspace).toHaveBeenCalledWith("w", { layout: { subagentPaneOpen: true, changesPanelOpen: true } }));
    // Hiding it brings the sub-agents back.
    fireEvent.click(screen.getByRole("button", { name: "Hide Changes (Esc)" }));
    await waitFor(() => expect(subTablist()).not.toBeNull());
    expect(screen.queryByText("Not a git repository")).toBeNull();
  });

  it("marks a tab unread / read from its context menu (I-073)", async () => {
    renderAt("/projects/p/chats/w?tab=m1");
    fireEvent.contextMenu(mainTabs()[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark as Unread" }));
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("m2", { unread: true }));
    await waitFor(() => expect(sessions.value.find((s) => s.id === "m2")?.unread).toBe(true));
    fireEvent.contextMenu(mainTabs()[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Mark as Read" }));
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("m2", { unread: false }));
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

  describe("sub-agent chips, spawn cards and pane (I-080, I-084)", () => {
    const strip = () => screen.getByRole("region", { name: "Sub-agents" });
    const closedPane = () => {
      workspaces.value = [makeWorkspace({ id: "w", projectId: "p", title: "Workspace" })];
    };

    it("keeps the pane closed by default and shows a strip row per agent above the composer", () => {
      closedPane();
      renderAt("/projects/p/chats/w");
      expect(subTablist()).toBeNull();
      expect(screen.queryByRole("separator", { name: "Resize sub-agents" })).toBeNull();
      const rows = within(strip()).getAllByRole("button", { name: /^Open / });
      expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Open reviewer (Idle)", "Open tests (Idle)"]);
    });

    it("clicking an agent opens it in the pane; hiding keeps it (and saves the state)", async () => {
      closedPane();
      renderAt("/projects/p/chats/w");
      fireEvent.click(within(strip()).getByRole("button", { name: /^Open tests/ }));
      await waitFor(() => expect(subTablist()).not.toBeNull());
      expect(within(subTablist()!).getByRole("tab", { name: /tests/ }).getAttribute("aria-selected")).toBe("true");
      expect(api.updateWorkspace).toHaveBeenCalledWith("w", { layout: { subagentPaneOpen: true, changesPanelOpen: false, activeSubagentSessionId: { m1: "a2" } } });

      fireEvent.click(screen.getByRole("button", { name: "Hide Sub-agents (Esc)" }));
      await waitFor(() => expect(subTablist()).toBeNull());
      expect(api.updateWorkspace).toHaveBeenLastCalledWith("w", { layout: { subagentPaneOpen: false, changesPanelOpen: false, activeSubagentSessionId: { m1: "a2" } } });
      expect(api.deleteSession).not.toHaveBeenCalled();
      expect(within(strip()).getAllByRole("button", { name: /^Open / })).toHaveLength(2);
    });

    it("Esc inside the pane hides it", async () => {
      renderAt("/projects/p/chats/w");
      fireEvent.keyDown(within(subTablist()!).getAllByRole("tab")[0]!, { key: "Escape" });
      await waitFor(() => expect(subTablist()).toBeNull());
      expect(api.deleteSession).not.toHaveBeenCalled();
    });

    it("⌘W on the pane's last tab hides the pane instead of closing the agent", async () => {
      sessions.value = sessions.value.filter((s) => s.id !== "a2");
      renderAt("/projects/p/chats/w");
      within(subTablist()!).getAllByRole("tab")[0]!.focus();
      fireEvent.keyDown(window, { key: "w", metaKey: true });
      await waitFor(() => expect(subTablist()).toBeNull());
      expect(api.deleteSession).not.toHaveBeenCalled();
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("shows compact chips side by side, attention tinted, with Stop All in an overflow menu", async () => {
      closedPane();
      const running = { agent: null, task: "t", keepOpenReason: null, userEngaged: false, closing: false, doneAt: null, result: null };
      sessions.value = [
        ...sessions.value.map((s) => (s.id === "a1" ? { ...s, agentDisplayName: "Maya", agentColor: "teal", status: "working" as const, agent: { ...running, status: "working" as const } } : s)),
        makeSession({ id: "a3", workspaceId: "w", kind: "subagent", parentSessionId: "m1", agentName: "docs", title: "docs", createdAt: 5, status: "blocked" }),
      ];
      renderAt("/projects/p/chats/w");
      const chips = [...strip().querySelectorAll<HTMLElement>("[data-agent-chip]")];
      expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["Open Maya (Working)", "Open tests (Idle)", "Open docs (Needs input)"]);
      expect(chips[0]!.getAttribute("data-agent-color")).toBe("teal");
      expect(chips[0]!.getAttribute("title")).toContain("Maya · reviewer");
      expect(chips[2]!.getAttribute("data-attention")).toBe("warning");
      expect(chips[2]!.textContent).toContain("Waiting for your input");
      fireEvent.click(chips[2]!);
      await waitFor(() => expect(subTablist()).not.toBeNull());
      // The pane's tab shows the fun name in its colour, role greyed.
      const tab = within(subTablist()!).getAllByRole("tab")[0]!;
      expect(tab.textContent).toBe("Maya · reviewer");
      expect(tab.getAttribute("data-agent-color")).toBe("teal");

      const more = within(strip()).getByRole("button", { name: "Sub-agent actions" });
      fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
      fireEvent.click(await screen.findByRole("menuitem", { name: /Stop All/ }));
      await waitFor(() => expect(api.abort).toHaveBeenCalledTimes(2));
      expect(vi.mocked(api.abort).mock.calls.map((c) => c[0]).sort()).toEqual(["a1", "a3"]);
    });

    it("a done chip shows its report's first line; no overflow button when nothing runs", () => {
      closedPane();
      sessions.value = sessions.value.map((s) =>
        s.id === "a1"
          ? { ...s, agent: { agent: null, task: "Review login\nmore", keepOpenReason: null, userEngaged: false, closing: false, doneAt: 10, status: "done" as const, result: "All **good**." } }
          : s,
      );
      renderAt("/projects/p/chats/w");
      expect(strip().querySelector('[data-agent-chip="done"]')!.textContent).toContain("All good.");
      expect(within(strip()).queryByRole("button", { name: "Sub-agent actions" })).toBeNull();
    });

    it("a spawn call is the agent's card: fun name, status, Open, and it absorbs the report", async () => {
      closedPane();
      sessions.value = sessions.value.map((s) =>
        s.id === "m1"
          ? { ...s, spawnedAgents: [{ name: "reviewer", sessionId: "a1", displayName: "Maya", color: "pink", spawnedAt: 3 }, { name: "gone", sessionId: "x9", displayName: "Otis", color: "sky", spawnedAt: 4 }] }
          : s.id === "a1"
            ? { ...s, agentDisplayName: "Maya", agentColor: "pink" }
            : s,
      );
      const store = getChatSession("m1");
      const call = (id: string, agentName: string) => ({
        id: `a-${id}`,
        role: "assistant" as const,
        timestamp: 1,
        content: [{ type: "toolCall" as const, id, name: "spawn_agent", kind: "task" as const, input: { agentName, description: `Do ${agentName}` }, args: {} }],
      });
      store.transcript.value = {
        messages: [
          call("c1", "reviewer"),
          call("c2", "gone"),
          { id: "u1", role: "user", content: [{ type: "text", text: formatAgentFinished("gone", "Otis's **report**.") }], timestamp: 9 },
        ],
        toolResults: {},
      };
      store.status.value = "ready";
      renderAt("/projects/p/chats/w");
      const cards = await waitFor(() => {
        const found = [...document.querySelectorAll<HTMLElement>('[data-role="agent-spawn"]')];
        expect(found).toHaveLength(2);
        return found;
      });
      expect(cards[0]!.getAttribute("data-agent-color")).toBe("pink");
      expect(cards[0]!.textContent).toContain("Maya· reviewer");
      // The closed agent's card shows its report; the separate report card is gone.
      expect(cards[1]!.getAttribute("data-kind")).toBe("done");
      expect(cards[1]!.textContent).toContain("Otis's report.");
      expect(document.querySelector('[data-role="agent-message"]')).toBeNull();
      fireEvent.click(within(cards[1]!).getByRole("button", { expanded: false }));
      expect(cards[1]!.querySelector("[data-spawn-details]")!.textContent).toContain("Task: Do gone");
      expect(within(cards[1]!).queryByRole("button", { name: /^Open/ })).toBeNull();
      fireEvent.click(within(cards[0]!).getByRole("button", { name: "Open Maya" }));
      await waitFor(() => expect(subTablist()).not.toBeNull());
      expect(within(subTablist()!).getByRole("tab", { name: /Maya/ }).getAttribute("aria-selected")).toBe("true");
    });

    it("clicking the agent's name in a report card opens it in the pane", async () => {
      closedPane();
      const store = getChatSession("m1");
      store.transcript.value = {
        messages: [{ id: "u1", role: "user", content: [{ type: "text", text: formatAgentFinished("reviewer", "Looks good.") }], timestamp: 1 }],
        toolResults: {},
      };
      store.status.value = "ready";
      renderAt("/projects/p/chats/w");
      const card = await waitFor(() => document.querySelector('[data-role="agent-message"]') as HTMLElement);
      fireEvent.click(card.querySelector("[data-agent-link]")!);
      await waitFor(() => expect(subTablist()).not.toBeNull());
      expect(within(subTablist()!).getByRole("tab", { name: /reviewer/ }).getAttribute("aria-selected")).toBe("true");
    });
  });
});
