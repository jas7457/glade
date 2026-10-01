/**
 * Terminal tabs in the workspace (I-187), with a mocked terminal widget, server calls and socket:
 * the tab kind in the main strip, ⌃` / the New Tab menu, switching, closing (SIGHUP via the API),
 * the output view and "Session ended"; I-192: closing a busy shell asks first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSettings, TERMINAL_MISSING_CLOSE_CODE, type WorkspaceLayout } from "@glade/protocol";
import { ConfirmHost, TooltipProvider } from "@glade/app-core/ui";
import { models, projects, sessions, settings, workspaces, workspacesById } from "@glade/app-core/state/store";
import { resetChatSessions } from "@glade/app-core/state/chat-session";
import { makeProject, makeSession, makeWorkspace } from "@glade/app-core/test/fixtures";
import { ChatRoute } from "@/app/RouteViews";
import { maximizedGroup } from "./layout-actions";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    getSession: vi.fn(() => new Promise(() => {})),
    listCommands: vi.fn(() => new Promise(() => {})),
    updateWorkspace: vi.fn(async (id: string, patch: { layout?: WorkspaceLayout }) => ({ ...workspaces.value.find((w) => w.id === id), ...patch })),
    updateSession: vi.fn(),
    createSession: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
  },
  request: vi.fn(async () => ({ isRepo: false })),
  localBaseUrl: () => "http://127.0.0.1:5317/api",
}));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) }, wsUrlFromApiBase: () => "ws://127.0.0.1:5317/ws" }));
vi.mock("@/features/terminal/terminal-api", () => ({
  startTerminal: vi.fn(async (workspaceId: string, id: string) => ({ id, workspaceId, cwd: "/repo", shell: "/bin/zsh", pid: 1, cols: 80, rows: 24, startedAt: 1, exit: null })),
  closeTerminal: vi.fn(async () => undefined),
  listTerminals: vi.fn(async () => []),
  terminalSocketUrl: vi.fn(async (_w: string, id: string) => `ws://host/ws/terminal/${id}`),
  newTerminalId: vi.fn(() => "term-new"),
}));
const written: string[] = [];
vi.mock("@/features/terminal/xterm-host", () => ({
  createXterm: () => ({
    cols: 90,
    rows: 20,
    write: (d: string) => written.push(d),
    reset: () => written.splice(0),
    clear: () => {},
    focus: () => {},
    fit: () => false,
    onData: () => {},
    onResize: () => {},
    onTitle: () => {},
    dispose: () => {},
  }),
}));
const { api } = await import("@glade/app-core/lib/api");
const terminalApi = await import("@/features/terminal/terminal-api");

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: unknown[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(JSON.parse(d));
  }
  close() {}
}

Element.prototype.scrollTo ??= function () {};

function renderAt(url: string) {
  const router = createMemoryRouter([{ path: "/projects/:projectId/chats/:chatId", element: <ChatRoute /> }], { initialEntries: [url] });
  render(
    <TooltipProvider>
      <RouterProvider router={router} />
      <ConfirmHost />
    </TooltipProvider>,
  );
  return router;
}

const mainTabs = () => within(screen.getByRole("tablist", { name: "Conversations" })).getAllByRole("tab");

beforeEach(() => {
  vi.clearAllMocks();
  FakeSocket.all = [];
  written.splice(0);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  resetChatSessions();
  maximizedGroup.value = {};
  settings.value = defaultSettings();
  models.value = [];
  projects.value = [makeProject({ id: "p" })];
  workspaces.value = [
    makeWorkspace({
      id: "w",
      projectId: "p",
      title: "Workspace",
      layout: { mainOrder: ["m1", "t1", "m2"], terminals: [{ id: "t1", createdAt: 1 }] },
    }),
  ];
  sessions.value = [makeSession({ id: "m1", workspaceId: "w", title: "Fix login", createdAt: 1 }), makeSession({ id: "m2", workspaceId: "w", title: "Tab 2", createdAt: 2 })];
});
afterEach(() => vi.unstubAllGlobals());

describe("terminal tabs", () => {
  it("shows terminals among the conversations and opens one from ?tab=", async () => {
    renderAt("/projects/p/chats/w?tab=t1");
    expect(mainTabs().map((t) => t.textContent)).toEqual(["Fix login", "Terminal", "Tab 2"]);
    expect(mainTabs()[1]!.getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    expect(FakeSocket.all[0]!.url).toBe("ws://host/ws/terminal/t1");
    expect(document.querySelector('[data-terminal-view="t1"]')).not.toBeNull();
    // Output streams into the terminal; its size goes to the shell.
    FakeSocket.all[0]!.onmessage?.({
      data: JSON.stringify({ type: "snapshot", data: "~/repo $ ", info: { id: "t1", workspaceId: "w", cwd: "/repo", shell: "/bin/zsh", pid: 1, cols: 80, rows: 24, startedAt: 1, exit: null } }),
    } as MessageEvent);
    expect(written.join("")).toBe("~/repo $ ");
    expect(FakeSocket.all[0]!.sent).toEqual([{ type: "resize", cols: 90, rows: 20 }]);
  });

  it("switching to a conversation clears the focused terminal", async () => {
    workspaces.value = [{ ...workspaces.value[0]!, layout: { ...workspaces.value[0]!.layout, activeTerminalId: "t1" } }];
    const router = renderAt("/projects/p/chats/w");
    expect(mainTabs()[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(mainTabs()[0]!);
    await waitFor(() => expect(router.state.location.search).toBe("?tab=m1"));
    expect(workspacesById.value.get("w")!.layout?.activeTerminalId).toBeNull();
    expect(document.querySelector("[data-terminal-view]")).toBeNull();
    fireEvent.click(mainTabs()[1]!);
    await waitFor(() => expect(router.state.location.search).toBe("?tab=t1"));
    expect(workspacesById.value.get("w")!.layout?.activeTerminalId).toBe("t1");
  });

  it("⌃` starts a shell and opens it as the last tab", async () => {
    const router = renderAt("/projects/p/chats/w");
    fireEvent.keyDown(window, { key: "`", code: "Backquote", ctrlKey: true });
    await waitFor(() => expect(router.state.location.search).toBe("?tab=term-new"));
    expect(terminalApi.startTerminal).toHaveBeenCalledWith("w", "term-new", { cols: 80, rows: 24 });
    expect(mainTabs().map((t) => t.textContent)).toEqual(["Fix login", "Terminal", "Tab 2", "Terminal"]);
    expect(api.updateWorkspace).toHaveBeenLastCalledWith("w", {
      layout: expect.objectContaining({ mainOrder: ["m1", "t1", "m2", "term-new"], activeTerminalId: "term-new" }),
    });
  });

  it("the New Tab menu offers a conversation or a terminal", async () => {
    const router = renderAt("/projects/p/chats/w");
    await userEvent.click(screen.getByRole("button", { name: "Tab Menu" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /New Terminal/ }));
    await waitFor(() => expect(router.state.location.search).toBe("?tab=term-new"));
  });

  it("closing a terminal tab ends its shell and focuses the neighbour", async () => {
    const router = renderAt("/projects/p/chats/w?tab=t1");
    fireEvent.click(within(mainTabs()[1]!).getByRole("button", { name: "Close Terminal" }));
    await waitFor(() => expect(router.state.location.search).toBe("?tab=m2"));
    expect(terminalApi.closeTerminal).toHaveBeenCalledWith("w", "t1");
    expect(mainTabs().map((t) => t.textContent)).toEqual(["Fix login", "Tab 2"]);
    expect(workspacesById.value.get("w")!.layout).toMatchObject({ terminals: [], mainOrder: ["m1", "m2"], activeMainSessionId: "m2", activeTerminalId: null });
  });

  it("closing a terminal running a program asks first (I-192); Cancel keeps it, Terminate closes it", async () => {
    const info = { id: "t1", workspaceId: "w", cwd: "/repo", shell: "/bin/zsh", pid: 1, cols: 80, rows: 24, startedAt: 1, exit: null };
    vi.mocked(terminalApi.listTerminals).mockResolvedValue([{ ...info, foreground: "sleep 100" }]);
    const router = renderAt("/projects/p/chats/w?tab=t1");
    fireEvent.click(within(mainTabs()[1]!).getByRole("button", { name: "Close Terminal" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Terminate “sleep 100”?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(terminalApi.closeTerminal).not.toHaveBeenCalled();
    expect(mainTabs()).toHaveLength(3);

    // ⌘W asks too; Terminate closes it.
    fireEvent.keyDown(window, { key: "w", metaKey: true });
    const again = await screen.findByRole("alertdialog");
    await userEvent.click(within(again).getByRole("button", { name: "Terminate" }));
    await waitFor(() => expect(router.state.location.search).toBe("?tab=m2"));
    expect(terminalApi.closeTerminal).toHaveBeenCalledWith("w", "t1");
    expect(mainTabs().map((t) => t.textContent)).toEqual(["Fix login", "Tab 2"]);
  });

  it("an idle shell closes without asking", async () => {
    vi.mocked(terminalApi.listTerminals).mockResolvedValue([{ id: "t1", workspaceId: "w", cwd: "/repo", shell: "/bin/zsh", pid: 1, cols: 80, rows: 24, startedAt: 1, exit: null, foreground: null }]);
    renderAt("/projects/p/chats/w?tab=t1");
    fireEvent.click(within(mainTabs()[1]!).getByRole("button", { name: "Close Terminal" }));
    await waitFor(() => expect(terminalApi.closeTerminal).toHaveBeenCalledWith("w", "t1"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("'Session ended' after a restart, with New Session", async () => {
    renderAt("/projects/p/chats/w?tab=t1");
    await waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.onclose?.({ code: TERMINAL_MISSING_CLOSE_CODE } as CloseEvent);
    await screen.findByText("Session ended");
    fireEvent.click(screen.getByRole("button", { name: "New Session" }));
    await waitFor(() => expect(terminalApi.startTerminal).toHaveBeenCalledWith("w", "t1", { cols: 90, rows: 20 }));
    await waitFor(() => expect(FakeSocket.all).toHaveLength(2));
  });
});
