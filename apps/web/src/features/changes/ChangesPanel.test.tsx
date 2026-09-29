/** Changes panel (I-097): list, expand to diff, discard with confirm, commit with a generated message. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";
import type { GitChangesResponse, Transcript } from "@glade/protocol";
import { ConfirmHost, TooltipProvider } from "@glade/app-core/ui";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { sessions } from "@glade/app-core/state/store";
import { makeSession } from "@glade/app-core/test/fixtures";

vi.mock("@glade/app-core/features/changes/api", () => ({
  changesApi: {
    status: vi.fn(),
    diff: vi.fn(),
    revert: vi.fn(),
    commit: vi.fn(),
    commitMessage: vi.fn(),
  },
}));

import { changesApi } from "@glade/app-core/features/changes/api";
import { agentEditedPaths } from "./agent-edits";
import { resetChangesState } from "./changes-state";
import { ChangesPanel } from "./ChangesPanel";

const api = vi.mocked(changesApi);

const repo = (files: Extract<GitChangesResponse, { isRepo: true }>["files"]): GitChangesResponse => ({
  isRepo: true,
  branch: "main",
  root: "/repo",
  prefix: "",
  files,
  truncated: false,
});

const STATUS = repo([
  { path: "src/app.ts", kind: "modified", added: 3, removed: 1, binary: false },
  { path: "notes.md", kind: "untracked", added: 2, removed: 0, binary: false },
  { path: "logo.png", kind: "added", added: null, removed: null, binary: true },
]);

function renderPanel(onClose = vi.fn()) {
  render(
    <TooltipProvider>
      <ChangesPanel workspaceId="w" cwd="/repo" onClose={onClose} />
      <ConfirmHost />
    </TooltipProvider>,
  );
  return { onClose };
}

const rows = () => within(screen.getByRole("list", { name: "Changed files" })).getAllByRole("listitem");
const row = (path: string) => rows().find((r) => r.getAttribute("data-path") === path)!;

beforeEach(() => {
  vi.clearAllMocks();
  resetChangesState();
  resetChatSessions();
  sessions.value = [];
  api.status.mockResolvedValue(STATUS);
});

describe("ChangesPanel", () => {
  it("lists changed files with their kind and +/− counts, and the branch", async () => {
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("3 changed files")).toBeTruthy();
    expect(row("src/app.ts").textContent).toContain("M");
    expect(row("src/app.ts").textContent).toContain("app.ts");
    expect(row("src/app.ts").textContent).toContain("src");
    expect(row("src/app.ts").textContent).toContain("+3 −1");
    expect(row("notes.md").textContent).toContain("U");
    expect(row("logo.png").textContent).toContain("binary");
  });

  it("says when the folder isn't a git repository", async () => {
    api.status.mockResolvedValue({ isRepo: false });
    renderPanel();
    await waitFor(() => expect(screen.getByText("Not a git repository")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Commit/ })).toBeNull();
  });

  it("expands a file to its diff", async () => {
    api.diff.mockResolvedValue({
      path: "src/app.ts",
      binary: false,
      truncated: false,
      lines: [
        { type: "del", text: "old line", oldLine: 1 },
        { type: "add", text: "new line", newLine: 1 },
      ],
    });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(within(row("src/app.ts")).getByRole("button", { expanded: false }));
    await waitFor(() => expect(screen.getByText("new line")).toBeTruthy());
    expect(api.diff).toHaveBeenCalledWith("w", "src/app.ts");
    expect(screen.getByText("old line")).toBeTruthy();
  });

  it("refreshes with the refresh button", async () => {
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(3));
    api.status.mockResolvedValue(repo([]));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByText("No changes")).toBeTruthy());
  });

  it("discards a file's changes only after a confirm", async () => {
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(within(row("src/app.ts")).getByRole("button", { name: "Discard Changes…" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("src/app.ts");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.revert).not.toHaveBeenCalled();

    api.revert.mockResolvedValue(repo(STATUS.isRepo ? STATUS.files.slice(1) : []));
    fireEvent.click(within(row("src/app.ts")).getByRole("button", { name: "Discard Changes…" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard Changes" }));
    await waitFor(() => expect(api.revert).toHaveBeenCalledWith("w", ["src/app.ts"]));
    await waitFor(() => expect(rows()).toHaveLength(2));
  });

  it("commits the checked files with a generated message", async () => {
    api.commitMessage.mockResolvedValue({ message: "Update the app" });
    api.commit.mockResolvedValue({ commit: "abc1234", summary: "Update the app" });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(within(row("logo.png")).getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Commit 2 Files…" }));
    const dialog = await screen.findByRole("dialog");
    const commit = within(dialog).getByRole("button", { name: "Commit" }) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: /Generate/ }));
    await waitFor(() => expect((within(dialog).getByRole("textbox") as HTMLTextAreaElement).value).toBe("Update the app"));
    expect(api.commitMessage).toHaveBeenCalledWith("w", ["src/app.ts", "notes.md"]);
    fireEvent.click(commit);
    await waitFor(() => expect(api.commit).toHaveBeenCalledWith("w", "Update the app", ["src/app.ts", "notes.md"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("commits everything when all files are checked", async () => {
    api.commit.mockResolvedValue({ commit: "abc1234", summary: "All" });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Commit…" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.input(within(dialog).getByRole("textbox"), { target: { value: "All" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Commit" }));
    await waitFor(() => expect(api.commit).toHaveBeenCalledWith("w", "All", undefined));
  });

  it("marks files this chat's agent edited", async () => {
    sessions.value = [makeSession({ id: "s1", workspaceId: "w" })];
    const store = getChatSession("s1");
    store.status.value = "ready";
    store.transcript.value = transcriptEditing("/repo/src/app.ts");
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(within(row("src/app.ts")).getByLabelText("Edited by this chat's agent")).toBeTruthy();
    expect(within(row("notes.md")).queryByLabelText("Edited by this chat's agent")).toBeNull();
  });

  it("closes on Esc", async () => {
    const { onClose } = renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.keyDown(screen.getByRole("button", { name: "Refresh" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

function transcriptEditing(...paths: string[]): Transcript {
  return {
    messages: [
      {
        id: "a1",
        role: "assistant",
        timestamp: 1,
        content: paths.map((path, i) => ({ type: "toolCall" as const, id: `t${i}`, name: "edit", kind: "edit" as const, input: { path }, args: { path } })),
      },
    ],
    toolResults: {},
  } as Transcript;
}

describe("agentEditedPaths", () => {
  it("maps absolute and folder-relative tool paths to repository paths", () => {
    const t = transcriptEditing("/repo/sub/a.ts", "b.ts", "../c.ts", "/elsewhere/d.ts", "./x/../e.ts");
    expect([...agentEditedPaths([t], "/repo/sub", "/repo", "sub/")].sort()).toEqual(["c.ts", "sub/a.ts", "sub/b.ts", "sub/e.ts"]);
  });
  it("expands ~ and @ paths like the tool rows show them (I-158)", () => {
    const t = transcriptEditing("~/src/glade/apps/a.ts", "@apps/b.ts", "/Users/me/src/glade/./c.ts", "~/other/d.ts");
    expect([...agentEditedPaths([t], "/Users/me/src/glade", "/Users/me/src/glade", "")].sort()).toEqual(["apps/a.ts", "apps/b.ts", "c.ts"]);
  });
});
