/**
 * I-123 UI: the merged sidebar (one list, remote icons, cross-environment drag order), routes
 * (`/e/:envId/…` and legacy local routes), pickers filtered to the host environment, the new-chat
 * environment picker and the remote badge in the chat header's place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { MemoryRouter, RouterProvider, createMemoryRouter } from "react-router";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    request: vi.fn(async () => []),
    api: {
      reorderProjects: vi.fn(async () => []),
      reorderPinnedWorkspaces: vi.fn(async () => []),
      createWorkspace: vi.fn(),
      getProjectGit: vi.fn(async () => ({ isRepo: false, branch: null, branches: [], uncommittedFiles: 0, uncommittedPaths: [] })),
    },
  };
});
vi.mock("@/lib/api-folder", () => ({
  listFolderCommands: vi.fn(async () => []),
  searchFiles: vi.fn(async () => ({ entries: [], truncated: false })),
  getHarnessDefaults: vi.fn(async () => ({ model: null, thinkingLevel: null })),
}));
vi.mock("@/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));
vi.mock("@/features/workspace", () => ({
  WorkspaceView: ({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) => <div>{`view ${workspaceId}/${sessionId}`}</div>,
}));

import type { HarnessInfo } from "@glade/protocol";
import { api } from "@/lib/api";
import { TooltipProvider } from "@/ui";
import { Sidebar } from "@/features/sidebar";
import { ContextBar } from "@/features/chat/context-bar";
import { Composer } from "@/features/chat/Composer";
import { ChatRoute, HomeRoute, ProjectRoute } from "@/app/RouteViews";
import { restorableRoute } from "@/app/lastRoute";
import { chatPath, parseEnvPath, routes } from "@/app/routes";
import { routeContext } from "@/app/paths";
import { resetClientOrders } from "@/state/env-order";
import { newChatHarness } from "@/state/harnesses";
import { models, projects, projectsById, sessions, workspaces, workspacesById } from "@/state/store";
import { makeProject, makeSession, makeWorkspace } from "@/test/fixtures";
import { fakeEnv, makeModel, resetEnvironmentsForTest, useEnvironments } from "@/test/env-fixtures";

const harness = (id: string, label: string, isDefault = false): HarnessInfo =>
  ({ id, label, isDefault, capabilities: { compact: true, exportHtml: true, steering: true, uiRequests: true, usageLimits: false, commands: true, subagents: true, shell: true } }) as HarnessInfo;

function seedTwoEnvironments() {
  const b = fakeEnv({
    id: "B",
    name: "Studio",
    baseUrl: "http://127.0.0.1:5418/api",
    models: [makeModel("remote", "only-b", { name: "Only On B" })],
    harnesses: [harness("fake", "Fake agent", true), harness("acp:gemini", "Gemini")],
    api: { reorderProjects: vi.fn(async () => []) },
  });
  const { local } = useEnvironments(b);
  models.value = [makeModel("local", "only-a", { name: "Only On A" })];
  projects.value = [
    makeProject({ id: "pa1", name: "Alpha", sortOrder: 0, environmentId: local.id }),
    makeProject({ id: "pa2", name: "Bravo", sortOrder: 1, environmentId: local.id }),
    makeProject({ id: "pb1", name: "Remote One", sortOrder: 0, environmentId: "B" }),
  ];
  workspaces.value = [
    makeWorkspace({ id: "wa", projectId: null, title: "Local chat", environmentId: local.id }),
    makeWorkspace({ id: "wb", projectId: null, title: "Remote chat", environmentId: "B" }),
    makeWorkspace({ id: "wpb", projectId: "pb1", title: "Remote project chat", environmentId: "B" }),
  ];
  sessions.value = [makeSession({ id: "sb", workspaceId: "wpb", environmentId: "B" })];
  return { local, b };
}

beforeEach(() => {
  localStorage.clear();
  resetClientOrders();
  resetEnvironmentsForTest();
  newChatHarness.value = null;
});
afterEach(() => resetEnvironmentsForTest());

describe("merged sidebar", () => {
  const renderSidebar = () =>
    render(
      <TooltipProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Sidebar />
        </MemoryRouter>
      </TooltipProvider>,
    );

  it("lists every environment's projects and chats in one list with a remote icon on remote rows only", () => {
    seedTwoEnvironments();
    renderSidebar();
    const rows = [...document.querySelectorAll("[data-project-id]")].map((e) => e.getAttribute("data-project-id"));
    expect(rows).toEqual(["pa1", "pa2", "pb1"]); // no environment groups
    const remoteProject = document.querySelector('[data-project-id="pb1"]')!;
    expect(within(remoteProject as HTMLElement).getAllByRole("button", { name: "On Studio" }).length).toBe(1);
    expect(document.querySelector('[data-project-id="pa1"] [data-remote-badge]')).toBeNull();
    // Standalone chats: the remote one is marked.
    expect(screen.getByRole("button", { name: /Remote chat/ }).querySelector("[data-remote-badge]")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Local chat/ }).querySelector("[data-remote-badge]")).toBeNull();
  });

  it("shows the environment's name, address and status in the badge's popover", async () => {
    seedTwoEnvironments();
    renderSidebar();
    fireEvent.click(within(document.querySelector('[data-project-id="pb1"]') as HTMLElement).getByRole("button", { name: "On Studio" }));
    const popover = await screen.findByRole("dialog", { name: "Environment" });
    expect(popover.textContent).toContain("Studio");
    expect(popover.textContent).toContain("http://127.0.0.1:5418");
    expect(popover.textContent).toContain("Connected");
  });

  it("keeps a remote project dragged between local ones in place (client-side order)", async () => {
    seedTwoEnvironments();
    const { reorderProjects } = await import("@/state/actions");
    renderSidebar();
    await reorderProjects(["pa1", "pb1", "pa2"]);
    await waitFor(() => expect([...document.querySelectorAll("[data-project-id]")].map((e) => e.getAttribute("data-project-id"))).toEqual(["pa1", "pb1", "pa2"]));
    expect(api.reorderProjects).not.toHaveBeenCalled(); // A's own order didn't change
  });
});

describe("routes", () => {
  it("builds /e/:envId paths for other environments and plain paths for the local one", () => {
    seedTwoEnvironments();
    expect(routes.project("pb1")).toBe("/e/B/projects/pb1");
    expect(routes.project("pa1")).toBe("/projects/pa1");
    expect(chatPath(workspacesById.value.get("wpb")!, "sb")).toBe("/e/B/projects/pb1/chats/wpb?tab=sb");
    expect(chatPath(workspacesById.value.get("wa")!)).toBe("/chats/wa");
    expect(routes.home("B")).toBe("/e/B");
    expect(routes.home("local-env")).toBe("/");
    expect(parseEnvPath("/e/B/projects/p")).toEqual({ envId: "B", path: "/projects/p" });
    expect(parseEnvPath("/projects/p")).toEqual({ envId: null, path: "/projects/p" });
    expect(routeContext("/e/B/projects/pb1/chats/wpb", workspacesById.value)).toEqual({ workspaceId: "wpb", projectId: "pb1", isSettings: false, envId: "B" });
  });

  it("restores a remembered route of a connected environment; old routes mean the local one", () => {
    seedTwoEnvironments();
    const data = { workspacesById: workspacesById.value, projectsById: projectsById.value, hasEnvironment: (id: string) => id === "B" };
    expect(restorableRoute("/e/B/projects/pb1", data)).toBe("/e/B/projects/pb1");
    expect(restorableRoute("/e/GONE/projects/x", data)).toBeNull();
    expect(restorableRoute("/projects/pa1", data)).toBe("/projects/pa1");
  });

  it("resolves environment routes and redirects legacy links to a remote item to its /e/ path", async () => {
    seedTwoEnvironments();
    const router = createMemoryRouter(
      [
        { path: "/e/:envId", element: <div>env home</div> },
        { path: "/projects/:projectId/chats/:chatId", element: <ChatRoute /> },
        { path: "/e/:envId/projects/:projectId", element: <ProjectRoute /> },
        { path: "/e/:envId/projects/:projectId/chats/:chatId", element: <ChatRoute /> },
      ],
      { initialEntries: ["/projects/pb1/chats/wpb"] },
    );
    render(<RouterProvider router={router} />);
    await waitFor(() => expect(router.state.location.pathname).toBe("/e/B/projects/pb1/chats/wpb"));
    expect(screen.getByText("view wpb/sb")).toBeTruthy();
  });

  it("says an environment isn't connected when its new-chat route can't be served", () => {
    useEnvironments();
    const router = createMemoryRouter([{ path: "/e/:envId", element: <HomeRoute /> }], { initialEntries: ["/e/NOPE"] });
    render(
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>,
    );
    expect(screen.getByText("Environment not connected")).toBeTruthy();
  });
});

describe("pickers follow the host", () => {
  const renderUi = (ui: preact.ComponentChildren) =>
    render(
      <TooltipProvider>
        <MemoryRouter initialEntries={["/"]}>{ui}</MemoryRouter>
      </TooltipProvider>,
    );

  it("a new chat without a project picks the environment first, then that environment's agents", () => {
    seedTwoEnvironments();
    renderUi(<ContextBar projectId={null} envId="B" />);
    const bar = screen.getByRole("toolbar", { name: "New chat context" });
    const buttons = within(bar).getAllByRole("button");
    expect(buttons[0]!.getAttribute("aria-label")).toBe("Environment: Studio");
    expect(bar.textContent).not.toContain("Local");
    // B has two agents (the local one has none loaded): the agent picker comes next.
    expect(buttons[1]!.getAttribute("aria-label")).toBe("Agent: Fake agent");
  });

  it("lists every connected environment in the environment picker", async () => {
    seedTwoEnvironments();
    renderUi(<ContextBar projectId={null} envId={null} />);
    const trigger = screen.getByRole("button", { name: "Environment: This Mac" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    const items = await screen.findAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["This Mac", expect.stringContaining("Studio")]);
  });

  it("no environment picker for a project chat (it uses the project's) or with one environment", () => {
    seedTwoEnvironments();
    renderUi(<ContextBar projectId="pb1" />);
    expect(screen.queryByRole("button", { name: /^Environment/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Agent: Fake agent" })).toBeTruthy(); // B's agents
  });

  it("the model picker lists only the chat's environment's models", async () => {
    seedTwoEnvironments();
    const { unmount } = renderUi(<Composer projectId={null} envId="B" />);
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Only On B");
    unmount();
    renderUi(<Composer projectId="pa1" />);
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Only On A");
  });
});

describe("settings", () => {
  it("host sections show the device picked in the sidebar switcher; another device's are view only (I-155)", async () => {
    const { b } = seedTwoEnvironments();
    const updateSettings = vi.fn(async (patch: object) => ({ ...b.shell.settings.value, ...patch }));
    (b.api as unknown as { updateSettings: unknown }).updateSettings = updateSettings;
    const { SettingsView, SettingsNav } = await import("@/features/settings");
    const { settingsEnvironmentId } = await import("@/state/env-registry");
    settingsEnvironmentId.value = "B";
    render(
      <TooltipProvider>
        <MemoryRouter initialEntries={["/settings/models"]}>
          <SettingsNav />
          <SettingsView section="models" />
        </MemoryRouter>
      </TooltipProvider>,
    );
    // One switcher, at the top of the AI group in the sidebar.
    const ai = screen.getByRole("group", { name: "AI" });
    const switcher = within(ai).getByRole("button", { name: "Settings for device" });
    expect(switcher.textContent).toContain("Studio");
    expect(within(screen.getByRole("group", { name: "App" })).queryByRole("button", { name: "Settings for device" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Settings for device" })).toHaveLength(1);
    // B's models, not the local ones, under B's name, view only.
    expect(screen.getByLabelText("Device").textContent).toContain("Studio");
    expect(screen.getByRole("note").textContent).toContain("View only. Change this on Studio.");
    expect(screen.getByText("Only On B")).toBeTruthy();
    expect(screen.queryByText("Only On A")).toBeNull();
    const toggle = screen.getByRole("switch", { name: "Show Only On B" });
    expect(toggle.closest("fieldset")?.disabled).toBe(true);
    // The page's own device is "This Mac" and editable.
    settingsEnvironmentId.value = null;
    await waitFor(() => expect(switcher.textContent).toContain("This Mac"));
    expect(screen.getByLabelText("Device").textContent).toContain("This Mac");
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText("Only On A")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Show Only On A" }).closest("fieldset")?.disabled).toBe(false);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("a refused write from another device says where to change it (I-155)", async () => {
    const { b } = seedTwoEnvironments();
    const err = Object.assign(new Error("Change this on Studio."), { status: 403, code: "local_only" });
    (b.api as unknown as { updateSettings: unknown }).updateSettings = vi.fn(async () => Promise.reject(err));
    const { updateSettings } = await import("@/state/actions");
    const { toasts } = await import("@/state/toasts");
    const before = b.shell.settings.value;
    expect(await updateSettings({ models: { hiddenModels: ["x/y"] } }, "B")).toBe(false);
    expect(b.shell.settings.value).toBe(before);
    expect(toasts.value.at(-1)?.message).toBe("View only. Change this on Studio.");
  });

  const renderRemote = async () => {
    const { RemoteAccessSettings } = await import("./RemoteAccessSettings");
    return render(
      <TooltipProvider>
        <MemoryRouter>
          <RemoteAccessSettings />
        </MemoryRouter>
      </TooltipProvider>,
    );
  };

  it("Remote access (I-132/I-136): off shows only the master switch; on reveals sharing, then Connections", async () => {
    useEnvironments();
    const { remoteMaster, resetRemoteMaster } = await import("@/state/remote-master");
    resetRemoteMaster(false);
    await renderRemote();
    const master = screen.getByRole("switch", { name: /Remote access/ });
    expect(master.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("Connections")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Let other devices use this device" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect to a Device/ })).toBeNull();
    // The old client switch is gone.
    expect(screen.queryByRole("switch", { name: "Connect to other Glade environments" })).toBeNull();

    fireEvent.click(master);
    expect(remoteMaster.value).toBe(true);
    const connections = await screen.findByText("Connections");
    expect(screen.getByRole("button", { name: /Connect to a Device/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Share This Device/ })).toBeTruthy();
    const host = screen.getByRole("switch", { name: "Let other devices use this device" });
    // Sharing comes before Connections.
    expect(host.compareDocumentPosition(connections) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("No connections yet.")).toBeTruthy();
    resetRemoteMaster(false);
  });

  it("lists saved environments with their status, Retry and Pair Again", async () => {
    const { saveEnvironments } = await import("@/state/saved-environments");
    const { tailnetPeers } = await import("@/state/remote-status");
    const { resetRemoteMaster } = await import("@/state/remote-master");
    resetRemoteMaster(true);
    const retry = vi.fn();
    const off = fakeEnv({ id: "OFF", name: "Studio", baseUrl: "https://studio.tail.ts.net/api", status: "offline" });
    const asleep = fakeEnv({ id: "SLEEP", name: "Air", baseUrl: "https://air.tail.ts.net/api", status: "offline" });
    const lost = fakeEnv({ id: "LOST", name: "Mini", baseUrl: "https://mini.tail.ts.net/api", status: "error" });
    const gone = fakeEnv({ id: "GONE", name: "Pro", baseUrl: "https://pro.tail.ts.net/api", status: "needs-pairing" });
    const ok = fakeEnv({ id: "OK", name: "Book", baseUrl: "https://book.tail.ts.net/api", status: "live" });
    (lost as { retry?: () => void }).retry = retry;
    useEnvironments(off, asleep, lost, gone, ok);
    saveEnvironments([
      { id: "OFF", name: "Studio", urls: ["https://studio.tail.ts.net"], token: "t", remoteDisabled: true },
      { id: "SLEEP", name: "Air", urls: ["https://air.tail.ts.net"], token: "t" },
      { id: "LOST", name: "Mini", urls: ["https://mini.tail.ts.net"], token: "t" },
      { id: "GONE", name: "Pro", urls: ["https://pro.tail.ts.net"], token: "t" },
      { id: "OK", name: "Book", urls: ["https://book.tail.ts.net"], token: "t" },
    ]);
    tailnetPeers.value = new Map([
      ["air.tail.ts.net", false],
      ["mini.tail.ts.net", true],
    ]);
    await renderRemote();
    const texts = screen.getAllByTestId("environment-status").map((e) => e.textContent);
    expect(texts).toEqual([
      "studio.tail.ts.net · Remote access turned off on Studio",
      "air.tail.ts.net · Air is offline",
      "mini.tail.ts.net · Can't reach Mini",
      "pro.tail.ts.net · Needs pairing",
      "book.tail.ts.net · Connected",
    ]);
    // I-142: a status dot per row (grey off/offline, red can't reach / needs pairing, green connected).
    const dots = [...document.querySelectorAll('[data-line="uses"] [data-status-dot]')];
    expect(dots.map((d) => d.getAttribute("data-status-dot"))).toEqual(["off", "off", "error", "error", "on"]);
    expect(dots.map((d) => d.getAttribute("aria-label"))).toEqual(["Remote access turned off on Studio", "Air is offline", "Can't reach Mini", "Needs pairing", "Connected"]);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: "Pair Again…" })).toHaveLength(1);
    tailnetPeers.value = null;
    saveEnvironments([]);
    resetRemoteMaster(false);
  });

  it("the sidebar keeps a down environment listed, greyed, with its status (its projects hidden)", () => {
    const b = fakeEnv({ id: "B", name: "Studio", status: "remote-disabled" });
    useEnvironments(b);
    render(
      <TooltipProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Sidebar />
        </MemoryRouter>
      </TooltipProvider>,
    );
    const row = document.querySelector('[data-down-environment="B"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("Studio");
    expect(row.querySelector("[title]")?.getAttribute("title")).toBe("Remote access turned off on Studio");
    b.status.value = "live";
    return waitFor(() => expect(document.querySelector('[data-down-environment="B"]')).toBeNull());
  });
});
