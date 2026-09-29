/**
 * I-107: the chat header's location line (Local/Worktree + live branch) and I-106: "Open in"
 * opens the chat's folder in chats and the project folder on the new-chat screen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { MemoryRouter } from "react-router";
import { defaultSessionState, type GitChangesResponse, type WorkspaceSummary } from "@glade/protocol";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    openProject: vi.fn(async () => undefined),
    openWorkspace: vi.fn(async () => undefined),
  },
}));
vi.mock("@glade/app-core/features/changes/api", () => ({ changesApi: { status: vi.fn() } }));

import { api } from "@glade/app-core/lib/api";
import { changesApi } from "@glade/app-core/features/changes/api";
import { refreshChanges, useChangesAutoRefresh } from "@/features/changes";
import { resetChangesState } from "@/features/changes/changes-state";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { projects, sessions, workspaces } from "@glade/app-core/state/store";
import { harnesses } from "@glade/app-core/state/harnesses";
import { makeProject, makeSession, makeWorkspace } from "@glade/app-core/test/fixtures";
import { TooltipProvider } from "@glade/app-core/ui";
import { ChatHeader } from "./ChatHeader";
import { OpenInButton } from "@glade/app-core/features/chat/OpenInButton";

const status = vi.mocked(changesApi.status);
const repo = (branch: string | null, head = "abc1234"): GitChangesResponse => ({
  isRepo: true,
  branch,
  head,
  root: "/repo",
  prefix: "",
  files: [],
  truncated: false,
});

const local = makeWorkspace({ id: "local", projectId: "p", title: "Local chat", cwd: "/repo" });
const worktreeChat = makeWorkspace({
  id: "wt",
  projectId: "p",
  title: "Worktree chat",
  cwd: "/data/worktrees/sidebar",
  worktree: { path: "/data/worktrees/sidebar", branch: "glade/sidebar-polish", baseRef: "main", repoRoot: "/repo" },
});

/** The header as WorkspaceView mounts it: with the changes auto-refresh. */
function Header({ workspace }: { workspace: WorkspaceSummary }) {
  useChangesAutoRefresh(workspace.id, false);
  return <ChatHeader workspace={workspace} sessionId="s" />;
}

function renderHeader(workspace: WorkspaceSummary) {
  getChatSession("s").state.value = defaultSessionState();
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <Header workspace={workspace} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const location = () => document.querySelector<HTMLElement>("[title^='Works in']");

beforeEach(() => {
  vi.clearAllMocks();
  resetChangesState();
  resetChatSessions();
  projects.value = [makeProject({ id: "p", name: "sample-repo", path: "/repo" })];
  workspaces.value = [local, worktreeChat];
  sessions.value = [];
  harnesses.value = null;
});

describe("chat location line (I-107)", () => {
  it("shows Local and the live branch for a chat in the project folder", async () => {
    status.mockResolvedValue(repo("main"));
    renderHeader(local);
    await waitFor(() => expect(location()?.textContent).toBe("Local·main"));
    expect(location()!.title).toBe("Works in the project folder on branch main\n/repo");
  });

  it("shows Worktree and its branch right away, then the live one", async () => {
    let resolve!: (s: GitChangesResponse) => void;
    status.mockReturnValue(new Promise((r) => (resolve = r)));
    renderHeader(worktreeChat);
    expect(location()?.textContent).toBe("Worktree·glade/sidebar-polish");
    expect(location()!.title).toBe("Works in its own worktree on branch glade/sidebar-polish, from main\n/data/worktrees/sidebar");
    await act(async () => resolve(repo("glade/renamed")));
    expect(location()?.textContent).toBe("Worktree·glade/renamed");
  });

  it("updates when the branch changes (refresh, window focus)", async () => {
    status.mockResolvedValue(repo("main"));
    renderHeader(local);
    await waitFor(() => expect(location()?.textContent).toBe("Local·main"));
    status.mockResolvedValue(repo("feature"));
    await act(() => refreshChanges("local"));
    expect(location()?.textContent).toBe("Local·feature");
    status.mockResolvedValue(repo("other"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(location()?.textContent).toBe("Local·other"));
  });

  it("shows the short hash when HEAD is detached", async () => {
    status.mockResolvedValue(repo(null, "1a2b3c4"));
    renderHeader(local);
    await waitFor(() => expect(location()?.textContent).toBe("Local·1a2b3c4"));
    expect(location()!.title).toMatch(/^Works in the project folder on detached HEAD at 1a2b3c4/);
  });

  it("shows nothing for folders that aren't git repositories", async () => {
    status.mockResolvedValue({ isRepo: false });
    renderHeader(local);
    await waitFor(() => expect(status).toHaveBeenCalled());
    await act(async () => {});
    expect(location()).toBeNull();
    expect(screen.queryByText("Local")).toBeNull();
  });
});

describe("agent badge (I-119, I-176)", () => {
  const caps = { compact: true, exportHtml: true, steering: true, uiRequests: true, usageLimits: true, commands: true, subagents: true, shell: true };
  beforeEach(() => {
    status.mockResolvedValue(repo("main"));
    harnesses.value = [
      { id: "pi", label: "pi", isDefault: true, capabilities: caps },
      { id: "acp-fake", label: "Fake ACP", isDefault: false, capabilities: { ...caps, models: false } },
    ];
  });

  it("shows the agent next to the location when the chat doesn't use the default one", async () => {
    sessions.value = [makeSession({ id: "s", workspaceId: "local", harness: "acp-fake" })];
    renderHeader(local);
    await waitFor(() => expect(location()?.textContent).toBe("Local·main"));
    const badge = document.querySelector<HTMLElement>("[title^='Runs on']");
    expect(badge?.textContent).toBe("Fake ACP");
    expect(badge?.title).toBe("Runs on Fake ACP (ACP)");
  });

  it("shows the default agent too when the Mac offers two or more (I-176)", async () => {
    sessions.value = [makeSession({ id: "s", workspaceId: "local", harness: "pi" })];
    renderHeader(local);
    await waitFor(() => expect(location()?.textContent).toBe("Local·main"));
    const badge = document.querySelector<HTMLElement>("[title^='Runs on']");
    expect(badge?.textContent).toBe("pi");
    expect(badge?.title).toBe("Runs on pi");
  });

  it("shows nothing when the Mac offers one agent (I-176)", async () => {
    harnesses.value = [{ id: "pi", label: "pi", isDefault: true, capabilities: caps }];
    sessions.value = [makeSession({ id: "s", workspaceId: "local", harness: "pi" })];
    renderHeader(local);
    await waitFor(() => expect(location()?.textContent).toBe("Local·main"));
    expect(document.querySelector("[title^='Runs on']")).toBeNull();
  });
});

describe("Open in (I-106)", () => {
  beforeEach(() => status.mockResolvedValue(repo("main")));

  it("opens a local chat's folder via the workspace endpoint, named after the project", async () => {
    renderHeader(local);
    fireEvent.click(screen.getByRole("button", { name: "Open sample-repo in VS Code" }));
    await waitFor(() => expect(api.openWorkspace).toHaveBeenCalledWith("local", "vscode"));
    expect(api.openProject).not.toHaveBeenCalled();
  });

  it("opens a worktree chat's worktree", async () => {
    renderHeader(worktreeChat);
    fireEvent.click(screen.getByRole("button", { name: "Open worktree glade/sidebar-polish in VS Code" }));
    await waitFor(() => expect(api.openWorkspace).toHaveBeenCalledWith("wt", "vscode"));
  });

  it("opens the project folder on the new-chat screen", async () => {
    render(
      <TooltipProvider>
        <OpenInButton projectId="p" />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open sample-repo in VS Code" }));
    await waitFor(() => expect(api.openProject).toHaveBeenCalledWith("p", "vscode"));
    expect(api.openWorkspace).not.toHaveBeenCalled();
  });
});
