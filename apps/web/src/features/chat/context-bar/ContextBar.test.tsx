/**
 * I-105: the new-chat context bar — which buttons show per project type, the project popover,
 * Local/Worktree, picking a branch in both modes, the "commit to switch" dialog → commit →
 * switch, running chats blocking a switch, and "New branch…".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import { MemoryRouter, useLocation } from "react-router";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ApiRequestError: actual.ApiRequestError,
    request: vi.fn(),
    api: {
      getProjectGit: vi.fn(),
      checkoutProjectBranch: vi.fn(),
      createProjectBranch: vi.fn(),
      createWorkspace: vi.fn(),
    },
  };
});
vi.mock("@/features/changes/api", () => ({
  changesApi: { commit: vi.fn(), commitMessage: vi.fn() },
  projectChangesApi: { commit: vi.fn(async () => ({ commit: "abc1234", summary: "wip" })), commitMessage: vi.fn() },
}));

import type { ProjectGitInfo } from "@glade/protocol";
import { ApiRequestError, api } from "@/lib/api";
import { projectChangesApi } from "@/features/changes/api";
import { createWorkspace } from "@/state/actions";
import { projects, workspaces } from "@/state/store";
import { addProjectOpen } from "@/state/ui";
import { newChatWorktree, newChatWorktreeOptions, projectGit } from "@/state/worktrees";
import { makeProject, makeWorkspace } from "@/test/fixtures";
import { TooltipProvider } from "@/ui";
import { ContextBar } from "./ContextBar";

const mocked = vi.mocked(api);

const git = (over: Partial<ProjectGitInfo> = {}): ProjectGitInfo => ({
  isRepo: true,
  branch: "main",
  branches: [
    { name: "main", current: true, isDefault: true, committedAt: 3 },
    { name: "dev", current: false, isDefault: false, committedAt: 2 },
    { name: "old", current: false, isDefault: false, committedAt: 1 },
  ],
  uncommittedFiles: 0,
  uncommittedPaths: [],
  ...over,
});

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderBar(projectId: string | null = "p") {
  return render(
    <MemoryRouter initialEntries={[projectId ? `/projects/${projectId}` : "/"]}>
      <TooltipProvider>
        <ContextBar projectId={projectId} />
        <Where />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const button = (name: RegExp) => screen.getByRole("button", { name });
const option = (name: string | RegExp) => screen.getByRole("option", { name });

beforeEach(() => {
  vi.clearAllMocks();
  projectGit.value = new Map();
  newChatWorktree.value = null;
  newChatWorktreeOptions.value = null;
  addProjectOpen.value = false;
  projects.value = [makeProject({ id: "p", name: "Glade", sortOrder: 0 }), makeProject({ id: "q", name: "Other", sortOrder: 1 })];
  workspaces.value = [];
  mocked.getProjectGit.mockResolvedValue(git());
});

describe("context bar", () => {
  it("shows project, work-in and branch for git projects; only the project otherwise", async () => {
    const { unmount } = renderBar("p");
    expect(await screen.findByRole("button", { name: /Branch: main/ })).toBeTruthy();
    expect(button(/Project: Glade/)).toBeTruthy();
    expect(button(/Work in: local/)).toBeTruthy();
    unmount();

    mocked.getProjectGit.mockResolvedValue(git({ isRepo: false, branch: null, branches: [] }));
    projectGit.value = new Map();
    const second = renderBar("q");
    await waitFor(() => expect(projectGit.value.get("q")).toBeDefined());
    expect(button(/Project: Other/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Work in/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Branch/ })).toBeNull();
    second.unmount();

    renderBar(null);
    expect(button(/Project: none/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Work in/ })).toBeNull();
  });

  it("project popover: search, ✓ current, pick another, No Project, Add Project…", async () => {
    renderBar("p");
    fireEvent.click(button(/Project: Glade/));
    expect(option("Glade").getAttribute("aria-checked")).toBe("true");
    fireEvent.input(screen.getByPlaceholderText("Search projects"), { target: { value: "oth" } });
    expect(screen.queryByRole("option", { name: "Glade" })).toBeNull();
    expect(option("Add Project…")).toBeTruthy(); // actions always show
    fireEvent.keyDown(screen.getByPlaceholderText("Search projects"), { key: "Enter" });
    expect(screen.getByTestId("where").textContent).toBe("/projects/q");

    fireEvent.click(button(/Project: Glade/));
    fireEvent.click(option("No Project"));
    expect(screen.getByTestId("where").textContent).toBe("/");

    fireEvent.click(button(/Project: Glade/));
    fireEvent.click(option("Add Project…"));
    expect(addProjectOpen.value).toBe(true);
  });

  it("worktree mode: branch picks the base (no checkout); createWorkspace sends it; leaving resets", async () => {
    const { unmount } = renderBar("p");
    const workIn = await screen.findByRole("button", { name: /Work in: local/ });
    fireEvent.pointerDown(workIn, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /New worktree/ }));
    expect(newChatWorktree.value).toBe("p");
    fireEvent.click(await screen.findByRole("button", { name: /Branch: from main/ }));
    expect(option("main").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(option("dev"));
    expect(mocked.checkoutProjectBranch).not.toHaveBeenCalled();
    expect(button(/Branch: from dev/)).toBeTruthy();

    // Name the branch.
    fireEvent.click(button(/Branch: from dev/));
    fireEvent.click(option("Name New Branch…"));
    fireEvent.input(screen.getByRole("textbox", { name: "Branch name" }), { target: { value: "feat/x" } });
    fireEvent.click(screen.getByRole("button", { name: "Use Name" }));
    expect(button(/Branch: feat\/x/)).toBeTruthy();

    mocked.createWorkspace.mockResolvedValue({ workspace: makeWorkspace({ id: "n" }), sessions: [], session: undefined } as never);
    await createWorkspace({ projectId: "p", prompt: "x" }).catch(() => {});
    expect(mocked.createWorkspace).toHaveBeenLastCalledWith({ projectId: "p", prompt: "x", worktree: true, baseRef: "dev", branch: "feat/x" });
    expect(newChatWorktree.value).toBeNull();

    newChatWorktree.value = "p";
    unmount();
    expect(newChatWorktree.value).toBeNull(); // remembers nothing
  });

  it("worktree mode: brings uncommitted changes only from the current branch, off by default (I-117)", async () => {
    mocked.getProjectGit.mockResolvedValue(git({ uncommittedFiles: 3, uncommittedPaths: ["a", "b", "c"] }));
    renderBar("p");
    await screen.findByRole("button", { name: /Branch: main/ });
    newChatWorktree.value = "p";
    fireEvent.click(await screen.findByRole("button", { name: /Branch: from main/ }));
    const carry = option(/Bring my uncommitted changes \(3 files\)/);
    expect(carry.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(carry);
    const trigger = button(/Branch: from main, with 3 uncommitted files/);
    expect(trigger.textContent).toContain("+ 3 changes");

    mocked.createWorkspace.mockResolvedValue({ workspace: makeWorkspace({ id: "n" }), sessions: [], session: undefined } as never);
    await createWorkspace({ projectId: "p", prompt: "x" }).catch(() => {});
    expect(mocked.createWorkspace).toHaveBeenLastCalledWith({ projectId: "p", prompt: "x", worktree: true, carryChanges: true });

    // Another base: the option is hidden and not sent.
    newChatWorktree.value = "p";
    fireEvent.click(await screen.findByRole("button", { name: /Branch: from main/ }));
    expect(option(/Bring my uncommitted changes/).getAttribute("aria-checked")).toBe("false"); // reset after creating
    fireEvent.click(option(/Bring my uncommitted changes/));
    fireEvent.click(button(/Branch: from main/));
    fireEvent.click(option("dev"));
    fireEvent.click(button(/Branch: from dev/));
    expect(screen.queryByRole("option", { name: /Bring my uncommitted changes/ })).toBeNull();
    await createWorkspace({ projectId: "p", prompt: "y" }).catch(() => {});
    expect(mocked.createWorkspace).toHaveBeenLastCalledWith({ projectId: "p", prompt: "y", worktree: true, baseRef: "dev" });
  });

  it("worktree mode: no carry option without uncommitted files", async () => {
    renderBar("p");
    await screen.findByRole("button", { name: /Branch: main/ });
    newChatWorktree.value = "p";
    fireEvent.click(await screen.findByRole("button", { name: /Branch: from main/ }));
    expect(screen.queryByRole("option", { name: /Bring my uncommitted changes/ })).toBeNull();
  });

  it("local mode: picking a branch checks it out when the folder is clean", async () => {
    mocked.checkoutProjectBranch.mockResolvedValue(git({ branch: "dev" }));
    renderBar("p");
    fireEvent.click(await screen.findByRole("button", { name: /Branch: main/ }));
    fireEvent.click(option("dev"));
    await waitFor(() => expect(mocked.checkoutProjectBranch).toHaveBeenCalledWith("p", "dev"));
    expect(await screen.findByRole("button", { name: /Branch: dev/ })).toBeTruthy();
  });

  it("local mode, dirty folder: commit dialog lists the files, Commit… commits, then switches", async () => {
    const dirty = git({ uncommittedFiles: 8, uncommittedPaths: ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "g.txt", "h.txt"] });
    mocked.getProjectGit.mockResolvedValue(dirty);
    mocked.checkoutProjectBranch.mockResolvedValue(git({ branch: "dev" }));
    renderBar("p");
    fireEvent.click(await screen.findByRole("button", { name: /Branch: main/ }));
    expect(within(option(/main/)).getByText("8 uncommitted files")).toBeTruthy();
    fireEvent.click(option("dev"));

    const dialog = await screen.findByRole("dialog", { name: "Commit your changes to switch branch" });
    expect(within(dialog).getByText("a.txt")).toBeTruthy();
    expect(within(dialog).getByText("and 2 more")).toBeTruthy();
    expect(mocked.checkoutProjectBranch).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Commit…" }));
    const commit = await screen.findByRole("dialog", { name: "Commit all changes" });
    fireEvent.input(within(commit).getByRole("textbox"), { target: { value: "wip" } });
    await act(async () => {
      fireEvent.click(within(commit).getByRole("button", { name: "Commit" }));
    });
    expect(projectChangesApi.commit).toHaveBeenCalledWith("p", "wip", undefined);
    await waitFor(() => expect(mocked.checkoutProjectBranch).toHaveBeenCalledWith("p", "dev"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("local mode: Cancel leaves everything; a 409 from the server on a clean-looking folder shows the dialog", async () => {
    renderBar("p");
    mocked.checkoutProjectBranch.mockRejectedValue(new ApiRequestError(409, "dirty"));
    mocked.getProjectGit.mockResolvedValue(git({ uncommittedFiles: 1, uncommittedPaths: ["x.txt"] }));
    fireEvent.click(await screen.findByRole("button", { name: /Branch: main/ }));
    fireEvent.click(option("old"));
    const dialog = await screen.findByRole("dialog", { name: "Commit your changes to switch branch" });
    expect(within(dialog).getByText("x.txt")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("local mode: a chat working in the project folder blocks switching and says which", async () => {
    workspaces.value = [makeWorkspace({ id: "busy", projectId: "p", title: "Fix login", running: true }), makeWorkspace({ id: "wt", projectId: "p", running: true, worktree: { path: "/wt", branch: "glade/x", baseRef: "main", repoRoot: "/r" } })];
    renderBar("p");
    fireEvent.click(await screen.findByRole("button", { name: /Branch: main/ }));
    expect(screen.getByText(/“Fix login” is working in the project folder/)).toBeTruthy();
    expect(option("dev").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(option("dev"));
    expect(mocked.checkoutProjectBranch).not.toHaveBeenCalled();
  });

  it("local mode: New Branch… creates and switches (prefilled from the search)", async () => {
    mocked.createProjectBranch.mockResolvedValue(git({ branch: "fix/it" }));
    renderBar("p");
    fireEvent.click(await screen.findByRole("button", { name: /Branch: main/ }));
    fireEvent.input(screen.getByPlaceholderText("Search branches"), { target: { value: "fix/it" } });
    fireEvent.click(option("New Branch “fix/it”…"));
    const field = screen.getByRole("textbox", { name: "Branch name" }) as HTMLInputElement;
    expect(field.value).toBe("fix/it");
    fireEvent.input(field, { target: { value: "bad name" } });
    expect(screen.getByText("Branch names can't contain spaces")).toBeTruthy();
    fireEvent.input(field, { target: { value: "fix/it" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create and Switch" }));
    });
    expect(mocked.createProjectBranch).toHaveBeenCalledWith("p", "fix/it", true);
    expect(await screen.findByRole("button", { name: /Branch: fix\/it/ })).toBeTruthy();
  });
});
