import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, emptyTranscript, type CreateWorkspaceResponse, type ModelInfo } from "@pi-ui/protocol";
import { TooltipProvider } from "@/ui";
import { models, settings, workspacesById } from "@/state/store";
import { makeSession, makeWorkspace } from "@/test/fixtures";
import { getChatSession, resetChatSessions } from "@/state/chat-session";
import { isSendKey } from "./composer-utils";
import { Composer } from "./Composer";

vi.mock("@/lib/api", () => ({
  api: {
    createWorkspace: vi.fn(),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    getSession: vi.fn(() => new Promise(() => {})),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    respondToUi: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

const { api } = await import("@/lib/api");

const MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "haiku", name: "Claude Haiku", thinkingLevels: ["off", "low", "medium", "high"], input: ["text", "image"] },
  { provider: "openai", id: "mini", name: "GPT Mini", thinkingLevels: ["off"], input: ["text"] },
];

const key = (k: Partial<Parameters<typeof isSendKey>[0]>) => ({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...k });

describe("isSendKey", () => {
  it("enter mode: Enter sends, Shift+Enter doesn't, ⌘Enter does", () => {
    expect(isSendKey(key({}), "enter")).toBe(true);
    expect(isSendKey(key({ shiftKey: true }), "enter")).toBe(false);
    expect(isSendKey(key({ altKey: true }), "enter")).toBe(false);
    expect(isSendKey(key({ metaKey: true }), "enter")).toBe(true);
    expect(isSendKey(key({ key: "a" }), "enter")).toBe(false);
  });
  it("mod-enter mode: only ⌘/Ctrl+Enter sends", () => {
    expect(isSendKey(key({}), "mod-enter")).toBe(false);
    expect(isSendKey(key({ metaKey: true }), "mod-enter")).toBe(true);
    expect(isSendKey(key({ ctrlKey: true }), "mod-enter")).toBe(true);
  });
  it("ignores keys during IME composition", () => {
    expect(isSendKey(key({ isComposing: true }), "enter")).toBe(false);
    expect(isSendKey(key({ keyCode: 229 }), "enter")).toBe(false);
  });
});

function renderAt(ui: preact.ComponentChildren) {
  const router = createMemoryRouter(
    [
      { path: "/", element: <TooltipProvider>{ui}</TooltipProvider> },
      { path: "/chats/:chatId", element: <div>chat page</div> },
      { path: "/projects/:projectId/chats/:chatId", element: <div>project chat page</div> },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function readyChat(chatId: string, running = false) {
  const store = getChatSession(chatId);
  store.status.value = "ready";
  store.state.value = { ...defaultSessionState(), model: { provider: "anthropic", id: "haiku" }, thinkingLevel: "medium", thinkingLevels: ["off", "low", "medium", "high"], isRunning: running };
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
  settings.value = defaultSettings();
  models.value = MODELS;
});

describe("Composer (existing chat)", () => {
  it("sends on Enter and inserts newline on Shift+Enter", async () => {
    readyChat("c1");
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(api.prompt).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("c1", { text: "hello", images: undefined, behavior: undefined }));
    expect(box.value).toBe("");
  });

  it("respects the mod-enter setting", async () => {
    settings.value = { ...defaultSettings(), general: { ...defaultSettings().general, sendKey: "mod-enter" } };
    readyChat("c1");
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "hi" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(api.prompt).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.prompt).toHaveBeenCalledTimes(1));
  });

  it("does not send empty messages", () => {
    readyChat("c1");
    renderAt(<Composer chatId="c1" />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("queues with the busy behaviour while running, shows Stop, Escape aborts", async () => {
    const store = readyChat("c1", true);
    store.state.value = { ...store.state.value, queue: { steering: ["earlier steer"], followUp: [] } };
    renderAt(<Composer chatId="c1" />);
    expect(screen.getByText("earlier steer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "also do this" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("c1", { text: "also do this", images: undefined, behavior: "steer" }));
    fireEvent.keyDown(box, { key: "Escape" });
    expect(api.abort).toHaveBeenCalledWith("c1");
  });

  it("restores the text when sending fails", async () => {
    vi.mocked(api.prompt).mockRejectedValueOnce(new Error("nope"));
    readyChat("c1");
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "keep me" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(box.value).toBe("keep me"));
  });

  it("renders an extension dialog and answers it", async () => {
    const store = readyChat("c1", true);
    store.uiRequests.value = [{ id: "r1", kind: "confirm", title: "Run rm -rf?", message: "Dangerous" }];
    renderAt(<Composer chatId="c1" />);
    expect(screen.getByRole("dialog", { name: "Run rm -rf?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(api.respondToUi).toHaveBeenCalledWith("c1", { id: "r1", confirmed: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows agent errors as a dismissible banner", () => {
    const store = readyChat("c1");
    store.agentError.value = "pi exited with code 1";
    renderAt(<Composer chatId="c1" />);
    expect(screen.getByRole("alert").textContent).toContain("pi exited with code 1");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Composer (new chat)", () => {
  it("creates the chat with the default model/thinking and navigates to it", async () => {
    settings.value = {
      ...defaultSettings(),
      models: { ...defaultSettings().models, defaultModel: { provider: "anthropic", id: "haiku" }, defaultThinkingLevel: "xhigh" },
    };
    // Workspace "new1" with its first session "s-new1".
    const session = makeSession({ id: "s-new1", workspaceId: "new1", title: "Hi", running: true });
    const detail: CreateWorkspaceResponse = {
      workspace: makeWorkspace({ id: "new1", projectId: "p1", title: "Hi" }),
      sessions: [session],
      session: { session, transcript: emptyTranscript(), state: defaultSessionState(), pendingUiRequests: [] },
    };
    vi.mocked(api.createWorkspace).mockResolvedValueOnce(detail);
    const router = renderAt(<Composer projectId="p1" />);
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Claude Haiku");
    // xhigh isn't supported by the model → clamped down to "high".
    expect(screen.getByRole("button", { name: "Thinking level" }).textContent).toContain("High");

    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "Hi there" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(api.createWorkspace).toHaveBeenCalledWith({
        projectId: "p1",
        prompt: "Hi there",
        images: undefined,
        model: { provider: "anthropic", id: "haiku" },
        thinkingLevel: "high",
      }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/p1/chats/new1"));
    expect(getChatSession("s-new1").status.value).toBe("ready");
    expect(workspacesById.value.has("new1")).toBe(true);
  });

  it("falls back to the first visible model and hides thinking for non-reasoning models", () => {
    models.value = [MODELS[1]!, MODELS[0]!];
    renderAt(<Composer projectId={null} />);
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("GPT Mini");
    expect(screen.queryByRole("button", { name: "Thinking level" })).toBeNull();
    // Text-only model: no attach button.
    expect(screen.queryByRole("button", { name: "Attach images" })).toBeNull();
  });
});
