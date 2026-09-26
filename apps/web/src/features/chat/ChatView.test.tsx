import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, type ChatSummary, type Transcript } from "@pi-ui/protocol";
import { TooltipProvider } from "@/ui";
import { chats, models, projects, settings } from "@/state/store";
import { getChatSession, resetChatSessions } from "@/state/chat-session";
import { ChatView } from "./ChatView";
import { shortenPath } from "./ChatHeader";

vi.mock("@/lib/api", () => ({
  api: {
    getChat: vi.fn(() => new Promise(() => {})),
    updateChat: vi.fn(async () => ({})),
    prompt: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/socket", () => ({ socket: { send: vi.fn(), setViewing: vi.fn() } }));
const { api } = await import("@/lib/api");

Element.prototype.scrollTo ??= function () {};

const chat: ChatSummary = {
  id: "c1", projectId: "p1", title: "Fix the sidebar", titleSource: "auto", cwd: "/Users/me/src/app", harness: "fake",
  sessionRef: null, pinned: false, unread: false, createdAt: 0, lastActivityAt: 0, model: null,
  thinkingLevel: null, running: false, status: "idle", pendingInputs: 0,
} as ChatSummary;

function setup(transcript?: Transcript, running = false) {
  const store = getChatSession("c1");
  store.status.value = "ready";
  store.state.value = { ...defaultSessionState(), isRunning: running };
  if (transcript) store.transcript.value = transcript;
  const router = createMemoryRouter([{ path: "/", element: <TooltipProvider><ChatView chatId="c1" /></TooltipProvider> }]);
  render(<RouterProvider router={router} />);
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
  settings.value = defaultSettings();
  models.value = [];
  chats.value = [chat];
  projects.value = [{ id: "p1", name: "app", path: "/Users/me/src/app", pinned: false, createdAt: 0, lastActivityAt: 0 }];
});

describe("ChatView", () => {
  it("shows title and project / shortened cwd", () => {
    setup();
    expect(screen.getByRole("button", { name: "Fix the sidebar" })).toBeTruthy();
    expect(screen.getByText(/app · ~\/src\/app/)).toBeTruthy();
  });

  it("renames inline: Enter saves, Escape cancels", async () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Fix the sidebar" }));
    let input = screen.getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
    input.value = "Sidebar resizing";
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.updateChat).toHaveBeenCalledWith("c1", { title: "Sidebar resizing" }));

    fireEvent.click(screen.getByRole("button", { name: "Fix the sidebar" }));
    input = screen.getByRole("textbox", { name: "Chat title" }) as HTMLInputElement;
    input.value = "Nope";
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Chat title" })).toBeNull();
    expect(api.updateChat).toHaveBeenCalledTimes(1);
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

  it("shortens home paths", () => {
    expect(shortenPath("/Users/me/src/x")).toBe("~/src/x");
    expect(shortenPath("/home/me")).toBe("~");
    expect(shortenPath("/tmp/x")).toBe("/tmp/x");
  });
});
