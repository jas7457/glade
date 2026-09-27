import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, type Transcript } from "@glade/protocol";
import { TooltipProvider } from "@/ui";
import { models, projects, sessions, settings, workspaces } from "@/state/store";
import { makeSession, makeWorkspace } from "@/test/fixtures";
import { getChatSession, resetChatSessions } from "@/state/chat-session";
import { toasts } from "@/state/toasts";
import { ChatView } from "./ChatView";
import { shortenPath } from "./NewChatView";

vi.mock("@/lib/api", () => ({
  api: {
    getSession: vi.fn(() => new Promise(() => {})),
    updateWorkspace: vi.fn(async () => ({})),
    updateSession: vi.fn(async () => ({})),
    prompt: vi.fn(async () => undefined),
    openProject: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));
const { api } = await import("@/lib/api");

Element.prototype.scrollTo ??= function () {};

// The workspace (sidebar row) and its session deliberately have different ids.
const chat = makeWorkspace({ id: "w1", projectId: "p1", title: "Fix the sidebar", cwd: "/Users/me/src/app" });
const session = makeSession({ id: "c1", workspaceId: "w1", title: "Tab title" });

function setup(transcript?: Transcript, running = false) {
  const store = getChatSession("c1");
  store.status.value = "ready";
  store.state.value = { ...defaultSessionState(), isRunning: running };
  if (transcript) store.transcript.value = transcript;
  const router = createMemoryRouter([{ path: "/", element: <TooltipProvider><ChatView workspaceId="w1" sessionId="c1" /></TooltipProvider> }]);
  render(<RouterProvider router={router} />);
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
  settings.value = defaultSettings();
  models.value = [];
  workspaces.value = [chat];
  sessions.value = [session];
  projects.value = [{ id: "p1", name: "app", path: "/Users/me/src/app", sortOrder: 0, createdAt: 0, lastActivityAt: 0 }];
});

describe("ChatView", () => {
  it("shows title and project name, but not the working folder", () => {
    setup();
    expect(screen.getByRole("button", { name: "Fix the sidebar" })).toBeTruthy();
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.queryByText(/src\/app/)).toBeNull();
  });

  it("shows no subtitle for standalone chats", () => {
    workspaces.value = [{ ...chat, projectId: null, cwd: "/Users/me/Library/Application Support/Glade/scratch" }];
    setup();
    expect(screen.getByRole("button", { name: "Fix the sidebar" })).toBeTruthy();
    expect(screen.queryByText(/scratch/)).toBeNull();
    expect(screen.queryByText("app")).toBeNull();
  });

  it("renames inline: Enter saves, Escape cancels", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Fix the sidebar" }));
    let input = screen.getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
    input.value = "Sidebar resizing";
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.updateWorkspace).toHaveBeenCalledWith("w1", { title: "Sidebar resizing" }));

    fireEvent.click(screen.getByRole("button", { name: "Fix the sidebar" }));
    input = screen.getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
    input.value = "Nope";
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Chat title" })).toBeNull();
    expect(api.updateWorkspace).toHaveBeenCalledTimes(1);
  });

  it("renders user and assistant messages, grouping tool calls", () => {
    setup({
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: "list files" }], timestamp: 0 },
        {
          id: "a1", role: "assistant", timestamp: 0, stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "t1", name: "bash", args: { command: "ls" } },
            { type: "toolCall", id: "t2", name: "read", args: { path: "a.ts" } },
          ],
        },
        { id: "a2", role: "assistant", timestamp: 0, stopReason: "stop", content: [{ type: "text", text: "All **done**." }] },
      ],
      toolResults: {
        t1: { toolCallId: "t1", toolName: "bash", status: "done", output: "a.ts" },
        t2: { toolCallId: "t2", toolName: "read", status: "done", output: "x" },
      },
    });
    expect(screen.getByText("list files")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ran 2 tool calls/ })).toBeTruthy();
    expect(screen.getByText("done").closest("[data-streamdown=strong], strong")).not.toBeNull();
  });

  it("shows a working indicator while running with nothing streaming", () => {
    setup(undefined, true);
    expect(screen.getAllByText("Working…").length).toBeGreaterThan(0);
  });

  it("shows a readable provider error with the raw text behind Details", async () => {
    const raw = '400 {"type":"error","error":{"type":"invalid_request_error","message":"image exceeds 10 MB maximum"}}';
    setup({
      messages: [
        { id: "u1", role: "user", content: [{ type: "text", text: "look" }], timestamp: 0 },
        {
          id: "a1", role: "assistant", timestamp: 0, stopReason: "error", content: [],
          errorMessage: "Image exceeds 10 MB maximum", errorDetails: raw,
        },
      ],
      toolResults: {},
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Image exceeds 10 MB maximum");
    expect(screen.queryByText(raw)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await waitFor(() => expect(screen.getByText(raw)).toBeTruthy());
  });

  it("offers Open in VS Code for project chats only", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
    await waitFor(() => expect(api.openProject).toHaveBeenCalledWith("p1", "vscode"));
  });

  it("shows no Open in VS Code button for standalone chats", () => {
    workspaces.value = [{ ...chat, projectId: null }];
    setup();
    expect(screen.queryByRole("button", { name: "Open in VS Code" })).toBeNull();
  });

  it("shows a toast when opening fails", async () => {
    vi.mocked(api.openProject).mockRejectedValueOnce(new Error("Visual Studio Code is not installed"));
    toasts.value = [];
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Open in VS Code" }));
    await waitFor(() => expect(toasts.value[0]?.message).toContain("not installed"));
  });

  it("shows the interrupted banner with Continue and Dismiss", async () => {
    sessions.value = [{ ...session, interrupted: true }];
    setup();
    expect(screen.getByText("This run was interrupted when Glade quit.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("c1", { text: "Continue where you left off." }));
    vi.mocked(api.updateSession).mockResolvedValueOnce({ ...session, interrupted: false });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledWith("c1", { interrupted: false }));
    await waitFor(() => expect(screen.queryByText("This run was interrupted when Glade quit.")).toBeNull());
  });

  it("hides the interrupted banner otherwise", () => {
    setup();
    expect(screen.queryByText(/was interrupted/)).toBeNull();
  });

  it("shortens home paths", () => {
    expect(shortenPath("/Users/me/src/x")).toBe("~/src/x");
    expect(shortenPath("/home/me")).toBe("~");
    expect(shortenPath("/tmp/x")).toBe("/tmp/x");
  });
});
