/**
 * I-096 web: the "New worktree" switch on the new-chat screen, the delete dialog for worktree
 * chats, the sidebar glyph and the create/delete actions.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { MemoryRouter } from "react-router";

vi.mock("@/lib/api", () => ({
  api: {
    getProjectGit: vi.fn(),
    getWorktreeStatus: vi.fn(),
    deleteWorkspace: vi.fn(async () => undefined),
    createWorkspace: vi.fn(),
  },
}));

import type { WorkspaceWorktree, WorktreeStatus } from "@glade/protocol";
import { api } from "@/lib/api";
import { ConfirmHost, TooltipProvider } from "@/ui";
import { createWorkspace } from "@/state/actions";
import { projects, workspaces } from "@/state/store";
import { newChatWorktree, projectGit } from "@/state/worktrees";
import { makeProject, makeWorkspace } from "@/test/fixtures";
import { WorktreeSwitch } from "@/features/chat/NewChatView";
import { ChatRow } from "./ChatRow";
import { confirmDeleteChat, DeleteChatHost } from "./delete-chat";

const mocked = vi.mocked(api);
const worktree: WorkspaceWorktree = { path: "/wt/fix", branch: "glade/fix", baseRef: "main", repoRoot: "/repo" };
const status = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  branch: "glade/fix",
  baseRef: "main",
  exists: true,
  uncommittedFiles: 0,
  ahead: 0,
  mergeBlocker: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  projectGit.value = new Map();
  newChatWorktree.value = null;
  projects.value = [makeProject({ id: "p" })];
  workspaces.value = [makeWorkspace({ id: "w", projectId: "p", title: "Fix it", worktree }), makeWorkspace({ id: "plain", projectId: "p" })];
});

describe("New worktree switch", () => {
  it("shows for git projects only, is off by default and turns on for its project", async () => {
    mocked.getProjectGit.mockResolvedValue({ isRepo: true, branch: "main" });
    const { unmount } = render(<WorktreeSwitch projectId="p" />);
    const toggle = await screen.findByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/branches off main/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(newChatWorktree.value).toBe("p");
    unmount();
    expect(newChatWorktree.value).toBeNull(); // remembers nothing
  });

  it("is hidden for folders that aren't git repositories", async () => {
    mocked.getProjectGit.mockResolvedValue({ isRepo: false, branch: null });
    render(<WorktreeSwitch projectId="p" />);
    await waitFor(() => expect(projectGit.value.get("p")).toBeDefined());
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("createWorkspace sends worktree: true when the switch is on for that project, then resets it", async () => {
    mocked.createWorkspace.mockResolvedValue({ workspace: makeWorkspace({ id: "n" }), sessions: [], session: undefined } as never);
    newChatWorktree.value = "p";
    await createWorkspace({ projectId: "other", prompt: "x" }).catch(() => {});
    expect(mocked.createWorkspace).toHaveBeenLastCalledWith({ projectId: "other", prompt: "x" });
    await createWorkspace({ projectId: "p", prompt: "x" }).catch(() => {});
    expect(mocked.createWorkspace).toHaveBeenLastCalledWith({ projectId: "p", prompt: "x", worktree: true });
  });
});

describe("deleting a worktree chat", () => {
  const renderHosts = () =>
    render(
      <TooltipProvider>
        <ConfirmHost />
        <DeleteChatHost />
      </TooltipProvider>,
    );

  it("shows the branch state and deletes with the chosen option", async () => {
    mocked.getWorktreeStatus.mockResolvedValue(status({ uncommittedFiles: 2, ahead: 3 }));
    renderHosts();
    const done = confirmDeleteChat(workspaces.value[0]!);
    expect(await screen.findByText(/2 uncommitted files/)).toBeTruthy();
    expect(screen.getByText(/3 commits not in main/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Discard" }));
    expect(screen.getByText(/including 3 commits not in main/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await done).toBe(true);
    expect(mocked.deleteWorkspace).toHaveBeenCalledWith("w", "discard");
  });

  it("keeps the branch by default; Cancel deletes nothing", async () => {
    mocked.getWorktreeStatus.mockResolvedValue(status());
    renderHosts();
    let done = confirmDeleteChat(workspaces.value[0]!);
    await screen.findByText(/No uncommitted changes/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await done).toBe(false);
    expect(mocked.deleteWorkspace).not.toHaveBeenCalled();

    done = confirmDeleteChat(workspaces.value[0]!);
    await screen.findByText(/No uncommitted changes/);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await done).toBe(true);
    expect(mocked.deleteWorkspace).toHaveBeenCalledWith("w", "keep");
  });

  it("disables Merge when the project folder can't take it", async () => {
    mocked.getWorktreeStatus.mockResolvedValue(status({ ahead: 1, mergeBlocker: "The project folder has uncommitted changes" }));
    renderHosts();
    const done = confirmDeleteChat(workspaces.value[0]!);
    const merge = await screen.findByRole("radio", { name: "Merge into main" });
    await waitFor(() => expect((merge as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/Merge isn't available: The project folder has uncommitted changes/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await done).toBe(false);
  });

  it("normal chats get the plain confirm", async () => {
    renderHosts();
    const done = confirmDeleteChat(workspaces.value[1]!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(await done).toBe(true);
    expect(mocked.getWorktreeStatus).not.toHaveBeenCalled();
    expect(mocked.deleteWorkspace).toHaveBeenCalledWith("plain");
  });
});

describe("sidebar row", () => {
  it("shows a branch glyph for worktree chats only", () => {
    const row = (id: string) =>
      render(
        <TooltipProvider>
          <MemoryRouter>
            <ChatRow chat={workspaces.value.find((w) => w.id === id)!} selected={false} />
          </MemoryRouter>
        </TooltipProvider>,
      );
    const { unmount } = row("w");
    expect(screen.getByLabelText("Worktree glade/fix")).toBeTruthy();
    unmount();
    row("plain");
    expect(screen.queryByLabelText(/Worktree/)).toBeNull();
  });
});
