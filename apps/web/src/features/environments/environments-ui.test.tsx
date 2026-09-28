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
  it("host sections edit the environment picked in the switcher", async () => {
    const { b } = seedTwoEnvironments();
    const updateSettings = vi.fn(async (patch: object) => ({ ...b.shell.settings.value, ...patch }));
    (b.api as unknown as { updateSettings: unknown }).updateSettings = updateSettings;
    const { SettingsView } = await import("@/features/settings");
    const { settingsEnvironmentId } = await import("@/state/env-registry");
    settingsEnvironmentId.value = "B";
    render(
      <TooltipProvider>
        <MemoryRouter>
          <SettingsView section="models" />
        </MemoryRouter>
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Environment" }).textContent).toContain("Studio");
    // B's models, not the local ones.
    expect(screen.getByText("Only On B")).toBeTruthy();
    expect(screen.queryByText("Only On A")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Show Only On B" }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ models: { hiddenModels: ["remote/only-b"] } }));
    // The page's own environment is "This Mac" ("Local" is the chat location, Local vs Worktree).
    settingsEnvironmentId.value = null;
    await waitFor(() => expect(screen.getByRole("button", { name: "Environment" }).textContent).toContain("This Mac"));
  });

  it("Remote access: the switch is off by default and saved per device", async () => {
    useEnvironments();
    const { RemoteAccessSettings } = await import("./RemoteAccessSettings");
    const { remoteAccessEnabled } = await import("@/state/environments");
    remoteAccessEnabled.value = false;
    render(
      <TooltipProvider>
        <RemoteAccessSettings />
      </TooltipProvider>,
    );
    const toggle = screen.getByRole("switch", { name: "Connect to other Glade environments" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: /Connect to Environment/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(toggle);
    expect(remoteAccessEnabled.value).toBe(true);
    expect(localStorage.getItem("glade.remoteAccess")).toBe("true");
    remoteAccessEnabled.value = false;
  });
});
