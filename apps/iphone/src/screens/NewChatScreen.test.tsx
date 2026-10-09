import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { RouterProvider, createMemoryRouter } from "react-router";
import type { HarnessInfo, ModelInfo } from "@glade/protocol";

vi.mock("@glade/app-core/state/actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@glade/app-core/state/actions")>()),
  createWorkspace: vi.fn(async (req: { projectId: string | null }) => ({
    workspace: { id: "new-ws", projectId: req.projectId, environmentId: "m2" },
    session: { session: { id: "s1" } },
  })),
}));
vi.mock("@glade/app-core/features/chat/slash/folder-commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@glade/app-core/features/chat/slash/folder-commands")>()),
  useFolderCommands: () => [],
}));

vi.mock("@glade/app-core/lib/api-folder", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@glade/app-core/lib/api-folder")>()),
  getFolderPermissionModes: vi.fn(async () => ({
    modes: [
      { id: "default", label: "Default", description: "Asks before edits and commands" },
      { id: "acceptEdits", label: "Accept edits" },
      { id: "plan", label: "Plan mode" },
    ],
    defaultMode: "default",
  })),
}));

import { createWorkspace } from "@glade/app-core/state/actions";
import { connections } from "@glade/app-core/state/env-registry";
import { newChatHarness } from "@glade/app-core/state/harnesses";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { newChatFolder } from "@glade/app-core/state/new-chat-folder";
import { folders, projects, workspaces } from "@glade/app-core/state/store";
import { folderIdRequestFor, setNewChatInFolder } from "@glade/app-core/state/new-chat-in-folder";
import { makeProject, makeWorkspace } from "@glade/app-core/test/fixtures";
import { chatPath } from "@glade/app-core/app/routes";
import { TooltipProvider } from "@glade/app-core/ui";
import { paths } from "~/app/routes";
import { fakeEnv } from "~/test/fake-env";
import { setVoiceEngine } from "~/voice/engine-provider";
import { createFakeVoiceEngine } from "~/voice/fake-engine";
import { closeVoiceMode, voiceMode } from "~/voice/voice-mode";
import { NewChatScreen, defaultNewChatEnv } from "./NewChatScreen";

const MODELS: ModelInfo[] = [{ provider: "anthropic", id: "haiku", name: "Claude Haiku", thinkingLevels: ["off", "low"], input: ["text"] }];

function harness(id: string, label: string, isDefault = false, models = true): HarnessInfo {
  return { id, label, isDefault, capabilities: { models } } as HarnessInfo;
}

function renderNew(entry = paths.newChat()) {
  const router = createMemoryRouter(
    [
      { path: "/new", element: <NewChatScreen /> },
      { path: "*", element: <div>elsewhere</div> },
    ],
    { initialEntries: ["/", entry], initialIndex: 1 },
  );
  render(
    <TooltipProvider>
      <RouterProvider router={router} />
    </TooltipProvider>,
  );
  return router;
}

describe("NewChatScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as { __GLADE_IPHONE__?: boolean }).__GLADE_IPHONE__ = true;
    newChatHarness.value = null;
    const m1 = fakeEnv("m1", "Studio");
    const m2 = fakeEnv("m2", "Air");
    for (const m of [m1, m2]) m.shell.models.value = MODELS;
    connections.value = [m1, m2];
    savedEnvironments.value = [
      { id: "m1", name: "Studio", urls: ["http://m1.test"], token: "t" },
      { id: "m2", name: "Air", urls: ["http://m2.test"], token: "t" },
    ];
    projects.value = [makeProject({ id: "p1", name: "Alpha", environmentId: "m1" }), makeProject({ id: "p2", name: "Beta", environmentId: "m2" })];
  });
  afterEach(() => {
    delete (window as { __GLADE_IPHONE__?: boolean }).__GLADE_IPHONE__;
    workspaces.value = [];
    folders.value = [];
    setNewChatInFolder(null);
    newChatFolder.value = null;
  });

  it("shows the empty state, picks Mac and project from the chips, sends, then replaces itself with the chat", async () => {
    const router = renderNew();
    expect(screen.getByRole("heading", { name: "What should we work on?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mac: Studio" }));
    fireEvent.click(screen.getByRole("button", { name: /^Air/ }));
    fireEvent.click(screen.getByRole("button", { name: "Project: none" }));
    // Only that Mac's projects are offered.
    expect(screen.queryByRole("button", { name: /Alpha/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Beta/ }));
    expect(screen.getByRole("button", { name: "Project: Beta" })).toBeTruthy();

    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText("Message"), { target: { value: "Hello there" } });
    await act(async () => {
      fireEvent.click(send);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe(chatPath({ id: "new-ws", projectId: "p2", environmentId: "m2" })));
    expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p2", prompt: "Hello there" }), "m2");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("voice mode: the first utterance starts the chat (like Send), then the conversation continues in it", async () => {
    const engine = createFakeVoiceEngine({ wordMs: 0, hearMs: 0 });
    setVoiceEngine(engine);
    const router = renderNew(`${paths.newChat()}?env=m2&project=p2`);
    fireEvent.click(screen.getByRole("button", { name: "Voice mode" }));
    expect(voiceMode.value?.sessionId).toBeNull();
    await waitFor(() => expect(engine.listening).toBe(true));
    await act(() => engine.hear("build a todo app"));
    await waitFor(() => expect(router.state.location.pathname).toBe(chatPath({ id: "new-ws", projectId: "p2", environmentId: "m2" })));
    expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p2", prompt: "build a todo app" }), "m2");
    expect(voiceMode.value?.sessionId).toBe("s1");
    expect(engine.listening).toBe(true);
    closeVoiceMode();
    setVoiceEngine(null);
  });

  it("keeps ?env=&project= preselection", () => {
    renderNew(`${paths.newChat()}?env=m2&project=p2`);
    expect(screen.getByRole("button", { name: "Mac: Air" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project: Beta" })).toBeTruthy();
  });

  describe("starting in a sidebar folder (I-215)", () => {
    const folder = (id: string, name: string, projectId: string | null) => ({ id, name, projectId, sortOrder: 0, createdAt: 0, environmentId: "m1" });
    beforeEach(() => {
      folders.value = [folder("W", "Work", null), folder("B", "Bugs", "p1")];
    });

    it("names a standalone folder and hands it to chat creation while the screen is open", () => {
      renderNew(paths.newChat({ envId: "m1", folderId: "W" }));
      expect(screen.getByTestId("new-chat-folder").textContent).toContain("in Work");
      expect(folderIdRequestFor(null)).toEqual({ folderId: "W" });
    });

    it("a project folder preselects its project and drops the folder when the project changes", () => {
      renderNew(paths.newChat({ envId: "m1", projectId: "p1", folderId: "B" }));
      expect(screen.getByRole("button", { name: "Project: Alpha" })).toBeTruthy();
      expect(screen.getByTestId("new-chat-folder").textContent).toContain("in Bugs");
      expect(folderIdRequestFor("p1")).toEqual({ folderId: "B" });
      fireEvent.click(screen.getByRole("button", { name: "Project: Alpha" }));
      fireEvent.click(screen.getByRole("button", { name: /No Project/ }));
      expect(screen.queryByTestId("new-chat-folder")).toBeNull();
      expect(folderIdRequestFor(null)).toEqual({});
    });

    it("ignores a folder of another list", () => {
      renderNew(paths.newChat({ envId: "m1", folderId: "B" }));
      expect(screen.queryByTestId("new-chat-folder")).toBeNull();
    });
  });

  it("offers the agent as a section of the Model & Thinking sheet when the Mac has several", () => {
    connections.value[0]!.shell.harnesses.value = [harness("pi", "Pi", true), harness("acp:claude", "Claude Code", false, false)];
    renderNew();
    fireEvent.click(screen.getByRole("button", { name: /^Model and thinking:/ }));
    expect(screen.getByRole("listbox", { name: "Agent" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Claude Code/ }));
    expect(newChatHarness.value).toBe("acp:claude");
    // That agent picks its own model: the pill shows the agent, and its sheet still switches back.
    fireEvent.click(screen.getByRole("button", { name: "Agent: Claude Code" }));
    fireEvent.click(screen.getByRole("option", { name: /^Pi/ }));
    expect(newChatHarness.value).toBeNull();
  });

  it("offers the picked agent's permission modes in the sheet and starts the chat in the chosen one (I-184)", async () => {
    connections.value[0]!.shell.harnesses.value = [
      harness("pi", "Pi", true),
      { ...harness("claude", "Claude Code"), capabilities: { models: true, permissionModes: true } } as HarnessInfo,
    ];
    const router = renderNew(`${paths.newChat()}?env=m1&project=p1`);
    fireEvent.click(screen.getByRole("button", { name: /^Model and thinking:/ }));
    // Pi has no modes: no Permissions section.
    expect(screen.queryByRole("listbox", { name: "Permissions" })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Claude Code/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Model and thinking:/ }));
    await waitFor(() => expect(screen.getByRole("listbox", { name: "Permissions" })).toBeTruthy());
    // The agent's own default is preselected.
    expect(screen.getByRole("option", { name: /^Default/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("option", { name: /^Plan mode/ }));
    fireEvent.input(screen.getByLabelText("Message"), { target: { value: "Plan the thing" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    await waitFor(() => expect(router.state.location.pathname).not.toBe("/new"));
    expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", harness: "claude", permissionMode: "plan" }), "m1");
  });

  describe("group projects (I-213)", () => {
    beforeEach(() => {
      projects.value = [...projects.value, makeProject({ id: "g1", name: "Monorepo", path: null, environmentId: "m1" })];
      workspaces.value = [
        makeWorkspace({ id: "w1", projectId: "g1", cwd: "/Users/me/repo/admin-web", createdAt: 1, environmentId: "m1" }),
        makeWorkspace({ id: "w2", projectId: "g1", cwd: "/Users/me/repo/polaris", createdAt: 2, environmentId: "m1" }),
        makeWorkspace({ id: "w3", projectId: "g1", cwd: "/Users/me/repo/admin-web", createdAt: 3, environmentId: "m1" }),
      ];
    });

    it("lists groups in the project sheet and shows a Folder chip only for them", () => {
      renderNew(`${paths.newChat()}?env=m1`);
      expect(screen.queryByRole("button", { name: /^Folder:/ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Project: none" }));
      expect(screen.getByText("Group · each chat picks its folder")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Monorepo/ }));
      expect(screen.getByRole("button", { name: "Folder: none" })).toBeTruthy();
      expect(screen.getByText("This group's chats each run in their own folder. Choose one to start.")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Voice mode" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("offers the group's chat folders, newest first; choosing one sets the new chat's folder", () => {
      renderNew(`${paths.newChat()}?env=m1&project=g1`);
      fireEvent.click(screen.getByRole("button", { name: "Folder: none" }));
      const rows = screen.getAllByRole("button", { name: /~\/repo\// });
      expect(rows.map((r) => r.textContent)).toEqual(["admin-web~/repo/admin-web", "polaris~/repo/polaris"]);
      expect(screen.getByRole("button", { name: /Browse…/ })).toBeTruthy();
      fireEvent.click(rows[1]!);
      expect(newChatFolder.value).toEqual({ projectId: "g1", path: "/Users/me/repo/polaris" });
      expect(screen.getByRole("button", { name: "Folder: polaris" })).toBeTruthy();
      expect(screen.getByText("~/repo/polaris")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Voice mode" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("forgets the folder when the project changes or the screen goes away", () => {
      const router = renderNew(`${paths.newChat()}?env=m1&project=g1`);
      fireEvent.click(screen.getByRole("button", { name: "Folder: none" }));
      fireEvent.click(screen.getByRole("button", { name: /polaris/ }));
      expect(newChatFolder.value).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Project: Monorepo" }));
      fireEvent.click(screen.getByRole("button", { name: /Alpha/ }));
      expect(newChatFolder.value).toBeNull();
      expect(screen.queryByRole("button", { name: /^Folder:/ })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Project: Alpha" }));
      fireEvent.click(screen.getByRole("button", { name: /Monorepo/ }));
      fireEvent.click(screen.getByRole("button", { name: "Folder: none" }));
      fireEvent.click(screen.getByRole("button", { name: /admin-web/ }));
      expect(newChatFolder.value).not.toBeNull();
      act(() => void router.navigate("/elsewhere"));
      expect(newChatFolder.value).toBeNull();
    });

    it("won't send until a folder is chosen", () => {
      renderNew(`${paths.newChat()}?env=m1&project=g1`);
      fireEvent.input(screen.getByLabelText("Message"), { target: { value: "Fix it" } });
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Folder: none" }));
      fireEvent.click(screen.getByRole("button", { name: /polaris/ }));
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("still holds the chosen folder when the chat is created (createWorkspace sends it)", async () => {
      let folderAtCreate: unknown = "unset";
      vi.mocked(createWorkspace).mockImplementationOnce(async (req) => {
        folderAtCreate = newChatFolder.value;
        return { workspace: { id: "new-ws", projectId: req.projectId, environmentId: "m1" }, session: { session: { id: "s1" } } } as never;
      });
      renderNew(`${paths.newChat()}?env=m1&project=g1`);
      fireEvent.click(screen.getByRole("button", { name: "Folder: none" }));
      fireEvent.click(screen.getByRole("button", { name: /polaris/ }));
      fireEvent.input(screen.getByLabelText("Message"), { target: { value: "Fix it" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
      });
      await waitFor(() => expect(createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ projectId: "g1" }), "m1"));
      expect(folderAtCreate).toEqual({ projectId: "g1", path: "/Users/me/repo/polaris" });
    });
  });

  it("hides the Mac chip with one Mac and defaults to a connected one", () => {
    connections.value = [fakeEnv("m1", "Studio")];
    renderNew();
    expect(screen.queryByRole("button", { name: /^Mac:/ })).toBeNull();
    expect(screen.queryByRole("listbox", { name: "Agent" })).toBeNull();
    connections.value = [fakeEnv("a", "A", "offline"), fakeEnv("b", "B")];
    expect(defaultNewChatEnv(null)).toBe("b");
    expect(defaultNewChatEnv("a")).toBe("a");
  });

  it("says what to check when the Mac can't be reached, with Retry (I-170)", () => {
    const studio = fakeEnv("m1", "Studio", "offline");
    const retry = vi.fn();
    studio.retry = retry;
    connections.value = [studio];
    renderNew(`${paths.newChat()}?env=m1`);
    expect(screen.getByRole("status").textContent).toContain("Can't reach Studio");
    expect(screen.getByText("Make sure it's awake with Glade open, and Tailscale is on on both.")).toBeTruthy();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).placeholder).toBe("Can't reach Studio");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
