import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, emptyTranscript, type CreateWorkspaceResponse, type ModelInfo } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { harnessDefaults, models, sessions, settings, workspacesById } from "@glade/app-core/state/store";
import { makeSession, makeWorkspace } from "@glade/app-core/test/fixtures";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { enterAction, parseShellInput } from "./composer-utils";
import { Composer } from "./Composer";
import { harnesses } from "@glade/app-core/state/harnesses";

const ALL_CAPS = { compact: true, exportHtml: true, steering: true, uiRequests: true, usageLimits: true, commands: true, subagents: true, shell: true };

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    createWorkspace: vi.fn(),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    getSession: vi.fn(() => new Promise(() => {})),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    respondToUi: vi.fn(async () => undefined),
    runShell: vi.fn(async () => ({ id: "shell-1" })),
  },
}));
vi.mock("@glade/app-core/lib/api-folder", () => ({
  listFolderCommands: vi.fn(async () => []),
  searchFiles: vi.fn(async (_projectId: string | null, q: string) => ({
    entries: q.startsWith("src/")
      ? [{ path: "src/app.ts", kind: "file" }]
      : [
          { path: "apps/web/Composer.tsx", kind: "file" },
          { path: "src", kind: "dir" },
          { path: "my docs/read me.md", kind: "file" },
        ],
    truncated: false,
  })),
  getHarnessDefaults: vi.fn(async () => ({ model: null, thinkingLevel: null })),
  getFolderPermissionModes: vi.fn(async () => ({ modes: [], defaultMode: null })),
}));
vi.mock("@glade/app-core/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

const { api } = await import("@glade/app-core/lib/api");
const folderApi = await import("@glade/app-core/lib/api-folder");

const MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "haiku", name: "Claude Haiku", thinkingLevels: ["off", "low", "medium", "high"], input: ["text", "image"] },
  { provider: "openai", id: "mini", name: "GPT Mini", thinkingLevels: ["off"], input: ["text"] },
];

const key = (k: Partial<Parameters<typeof enterAction>[0]>) => ({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...k });

describe("enterAction (I-153)", () => {
  it("↩ sends, ⌘↩/Ctrl↩ follow-up, ⌥↩ asks aside, ⇧↩ is a new line", () => {
    expect(enterAction(key({}))).toBe("send");
    expect(enterAction(key({ metaKey: true }))).toBe("followUp");
    expect(enterAction(key({ ctrlKey: true }))).toBe("followUp");
    expect(enterAction(key({ altKey: true }))).toBe("askAside");
    expect(enterAction(key({ shiftKey: true }))).toBeNull();
    expect(enterAction(key({ shiftKey: true, metaKey: true }))).toBeNull();
    expect(enterAction(key({ altKey: true, metaKey: true }))).toBeNull();
    expect(enterAction(key({ key: "a" }))).toBeNull();
  });
  it("ignores keys during IME composition", () => {
    expect(enterAction(key({ isComposing: true }))).toBeNull();
    expect(enterAction(key({ keyCode: 229 }))).toBeNull();
    expect(enterAction(key({ keyCode: 229, metaKey: true }))).toBeNull();
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

  it("does not send empty messages", () => {
    readyChat("c1");
    renderAt(<Composer chatId="c1" />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter" });
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("sends no steer/follow-up choice for harnesses without message queues (I-065)", async () => {
    harnesses.value = [{ id: "fake", label: "Fake", isDefault: true, capabilities: { ...ALL_CAPS, steering: false } }];
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "also do this" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("c1", { text: "also do this", images: undefined, behavior: undefined }));
    harnesses.value = null;
  });

  it("steers on ↩ while running, shows Stop, Escape aborts", async () => {
    const store = readyChat("c1", true);
    store.state.value = { ...store.state.value, queue: { steering: ["earlier steer"], followUp: [] } };
    renderAt(<Composer chatId="c1" />);
    expect(screen.getByText("earlier steer")).toBeTruthy();
    expect(screen.queryByText(/queued messages are sent after/)).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "also do this" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("c1", { text: "also do this", images: undefined, behavior: "steer" }));
    fireEvent.keyDown(box, { key: "Escape" });
    expect(api.abort).toHaveBeenCalledWith("c1");
  });

  it("says when messages still queued after a stop will be sent", () => {
    const store = readyChat("c1");
    store.state.value = { ...store.state.value, queue: { steering: [], followUp: ["do this next"] } };
    renderAt(<Composer chatId="c1" />);
    expect(screen.getByText("do this next")).toBeTruthy();
    expect(screen.getByText("Stopped: queued messages are sent after your next message")).toBeTruthy();
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

  it("is read-only while another Glade server runs the session (I-062)", () => {
    readyChat("c1", true);
    sessions.value = [makeSession({ id: "c1", status: "working", running: true, activeElsewhere: { serverKind: "dev", since: 1 } })];
    try {
      renderAt(<Composer chatId="c1" />);
      const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
      expect(box.disabled).toBe(true);
      expect(box.placeholder).toBe("Running in Glade (dev) — open it there or wait until it's idle");
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
      fireEvent.keyDown(box, { key: "Enter" });
      expect(api.prompt).not.toHaveBeenCalled();
    } finally {
      sessions.value = [];
    }
  });

  it("is read-only in a harness's own sub-agent, which can still be stopped (I-188)", async () => {
    readyChat("c1", true);
    sessions.value = [
      makeSession({
        id: "c1",
        kind: "subagent",
        parentSessionId: "p",
        status: "working",
        running: true,
        agent: { status: "working", agent: null, task: "Count", keepOpenReason: null, userEngaged: false, closing: false, doneAt: null, result: null, native: "Claude Code" },
      }),
    ];
    try {
      renderAt(<Composer chatId="c1" />);
      const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
      expect(box.disabled).toBe(true);
      expect(box.placeholder).toBe("Read-only: Claude Code's own sub-agent can't be messaged");
      fireEvent.keyDown(box, { key: "Enter" });
      expect(api.prompt).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await waitFor(() => expect(api.abort).toHaveBeenCalledWith("c1"));
    } finally {
      sessions.value = [];
    }
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

describe("Composer permission modes (I-174)", () => {
  const MODES = [
    { id: "default", label: "Default" },
    { id: "acceptEdits", label: "Accept edits" },
    { id: "plan", label: "Plan mode" },
    { id: "bypassPermissions", label: "Bypass permissions", danger: true },
  ];

  it("shows the mode pill and cycles the modes with Shift+Tab, bypass in red", async () => {
    const store = readyChat("c1");
    store.state.value = { ...store.state.value, permissionMode: "plan", permissionModes: MODES };
    renderAt(<Composer chatId="c1" />);
    const pill = () => screen.getByRole("button", { name: /^Permission mode:/ });
    expect(pill().getAttribute("aria-label")).toBe("Permission mode: Plan mode");
    expect(pill().dataset.danger).toBeUndefined();
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
    expect(api.setPermissionMode).toHaveBeenCalledWith("c1", "bypassPermissions");
    await waitFor(() => expect(pill().getAttribute("aria-label")).toBe("Permission mode: Bypass permissions"));
    expect(pill().dataset.danger).toBe("true");
    fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
    expect(api.setPermissionMode).toHaveBeenLastCalledWith("c1", "default"); // wraps around
  });

  it("puts the previous mode back when the agent refuses", async () => {
    vi.mocked(api.setPermissionMode).mockRejectedValueOnce(new Error("bypass is disabled"));
    const store = readyChat("c1");
    store.state.value = { ...store.state.value, permissionMode: "plan", permissionModes: MODES };
    renderAt(<Composer chatId="c1" />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Tab", shiftKey: true });
    await waitFor(() => expect(store.state.value.permissionMode).toBe("plan"));
  });

  it("has no pill (and Shift+Tab does nothing) for agents without modes", () => {
    readyChat("c1");
    renderAt(<Composer chatId="c1" />);
    expect(screen.queryByRole("button", { name: /^Permission mode:/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Tab", shiftKey: true });
    expect(api.setPermissionMode).not.toHaveBeenCalled();
  });

  it("focuses the composer after 'No, and tell Claude what to do differently'", async () => {
    const store = readyChat("c1", true);
    store.uiRequests.value = [
      {
        id: "p1",
        kind: "permission",
        title: "Allow Bash?",
        numbered: true,
        options: [
          { id: "allow", label: "Yes", kind: "allow_once" },
          { id: "reject", label: "No, and tell Claude what to do differently", kind: "reject_once", focusComposer: true },
        ],
      },
    ];
    renderAt(<Composer chatId="c1" />);
    expect(document.activeElement?.textContent).toMatch(/Yes/);
    fireEvent.click(screen.getByRole("option", { name: /No, and tell Claude/ }));
    expect(api.respondToUi).toHaveBeenCalledWith("c1", { id: "p1", value: "reject" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" })));
  });
});

describe("Composer send keys (I-153)", () => {
  const setSteering = (steering: boolean) => {
    harnesses.value = [{ id: "fake", label: "Fake", isDefault: true, capabilities: { ...ALL_CAPS, steering } }];
  };
  afterEach(() => {
    harnesses.value = null;
  });

  const cases: Array<{ steering: boolean; running: boolean }> = [
    { steering: true, running: false },
    { steering: true, running: true },
    { steering: false, running: false },
    { steering: false, running: true },
  ];
  it.each(cases)("key matrix: steering=$steering running=$running", async ({ steering, running }) => {
    setSteering(steering);
    readyChat("c1", running);
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    const type = (value: string) => fireEvent.input(box, { target: { value } });
    const choice = (behavior: "steer" | "followUp") => (running && steering ? behavior : undefined);

    // ⇧↩: a new line (the textarea's default), nothing sent.
    type("line");
    expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true })).toBe(true);
    // ⌥↩ without side questions: nothing sent.
    fireEvent.keyDown(box, { key: "Enter", altKey: true });
    // IME composition: nothing sent.
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true, keyCode: 229 });
    expect(api.prompt).not.toHaveBeenCalled();
    expect(box.value).toBe("line");

    // ↩: send (steer while running).
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "line", images: undefined, behavior: choice("steer") }));
    // ⌘↩ / Ctrl↩: follow-up while running, a plain send when idle.
    type("later");
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "later", images: undefined, behavior: choice("followUp") }));
    type("ctrl");
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "ctrl", images: undefined, behavior: choice("followUp") }));
    expect(api.prompt).toHaveBeenCalledTimes(3);
  });

  it("placeholder while running names the keys; harnesses without steering just queue", () => {
    setSteering(true);
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).placeholder).toBe("↩ steer · ⌘↩ follow-up");
  });

  it("holding ⌘ while running switches the send button to its follow-up form (keydown/keyup/blur)", async () => {
    setSteering(true);
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "after that" } });
    const button = () => screen.getByRole("button", { name: /^(Steer|Send follow-up)$/ }) as HTMLButtonElement;
    expect(button().getAttribute("aria-label")).toBe("Steer");
    expect(button().dataset.sendBehavior).toBe("steer");
    const steerIcon = button().innerHTML;
    const classes = button().className;

    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    expect(button().getAttribute("aria-label")).toBe("Send follow-up");
    expect(button().dataset.sendBehavior).toBe("followUp");
    expect(button().innerHTML).not.toBe(steerIcon);
    expect(button().className).toBe(classes); // same size and slot
    fireEvent.keyUp(window, { key: "Meta", metaKey: false });
    expect(button().getAttribute("aria-label")).toBe("Steer");
    expect(button().innerHTML).toBe(steerIcon);

    // The keyup can get lost (⌘Tab): blur and hiding the window reset it.
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    expect(button().getAttribute("aria-label")).toBe("Send follow-up");
    fireEvent.blur(window);
    expect(button().getAttribute("aria-label")).toBe("Steer");
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    expect(button().getAttribute("aria-label")).toBe("Steer");
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    // Clicking while ⌘ is held sends a follow-up; a plain click steers.
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    fireEvent.click(button());
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "after that", images: undefined, behavior: "followUp" }));
    fireEvent.keyUp(window, { key: "Meta", metaKey: false });
    fireEvent.input(box, { target: { value: "now" } });
    fireEvent.click(button());
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "now", images: undefined, behavior: "steer" }));
  });

  it("the button doesn't change with ⌘ when idle or without steering", async () => {
    setSteering(false);
    const store = readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Queue a message…");
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    expect(screen.getByRole("button", { name: "Queue message" })).toBeTruthy();
    fireEvent.keyUp(window, { key: "Meta", metaKey: false });
    setSteering(true);
    store.state.value = { ...store.state.value, isRunning: false };
    await waitFor(() => expect(box.placeholder).toBe("Ask anything…"));
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(box.placeholder).toBe("Ask anything…");
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

  it('"Default" preselects the harness default model/thinking and sends no model (I-050)', async () => {
    models.value = [MODELS[1]!, MODELS[0]!]; // the harness default isn't the first model
    harnessDefaults.value = { model: { provider: "anthropic", id: "haiku" }, thinkingLevel: "low" };
    vi.mocked(api.createWorkspace).mockReturnValueOnce(new Promise(() => {}));
    try {
      renderAt(<Composer projectId="p1" />);
      expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Claude Haiku");
      expect(screen.getByRole("button", { name: "Thinking level" }).textContent).toContain("Low");
      const box = screen.getByRole("textbox", { name: "Message" });
      fireEvent.input(box, { target: { value: "Hi" } });
      fireEvent.keyDown(box, { key: "Enter" });
      await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ model: null, thinkingLevel: "low" })));
    } finally {
      harnessDefaults.value = null;
    }
  });
});

describe("Composer (new chat in another agent, I-119)", () => {
  it("sends the picked ACP agent, no model, and hides the model pickers", async () => {
    models.value = MODELS;
    harnesses.value = [
      { id: "pi", label: "pi", isDefault: true, capabilities: ALL_CAPS },
      { id: "acp-gem", label: "Gemini", isDefault: false, capabilities: { ...ALL_CAPS, models: false, steering: false, shell: false } },
    ];
    const { newChatHarness } = await import("@glade/app-core/state/harnesses");
    newChatHarness.value = "acp-gem";
    vi.mocked(api.createWorkspace).mockReturnValueOnce(new Promise(() => {}));
    try {
      renderAt(<Composer projectId="p1" />);
      expect(screen.queryByRole("button", { name: "Model" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Thinking level" })).toBeNull();
      const box = screen.getByRole("textbox", { name: "Message" });
      fireEvent.input(box, { target: { value: "Hi" } });
      fireEvent.keyDown(box, { key: "Enter" });
      await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ harness: "acp-gem", model: null, thinkingLevel: null })));
    } finally {
      newChatHarness.value = null;
      harnesses.value = null;
    }
  });
});

describe("Composer (new chat: the picked agent's modes and commands, I-184/I-185)", () => {
  const MODES = [
    { id: "default", label: "Default" },
    { id: "acceptEdits", label: "Accept edits" },
    { id: "plan", label: "Plan mode" },
    { id: "bypassPermissions", label: "Bypass permissions", danger: true },
  ];
  const pill = () => screen.queryByRole("button", { name: /^Permission mode:/ });

  beforeEach(async () => {
    (await import("./new-chat-modes")).resetNewChatModes();
    (await import("./slash/folder-commands")).resetFolderCommands();
  });

  async function pickAgent(id: string, defaultMode: string | null = "default") {
    harnesses.value = [
      { id: "pi", label: "pi", isDefault: true, capabilities: ALL_CAPS },
      { id: "claude", label: "Claude Code", isDefault: false, capabilities: { ...ALL_CAPS, permissionModes: true } },
    ];
    vi.mocked(folderApi.getFolderPermissionModes).mockResolvedValue({ modes: MODES, defaultMode });
    vi.mocked(folderApi.listFolderCommands).mockImplementation(async (_p, _r, _v, harness) =>
      harness === "claude" ? [{ name: "security-review", description: "Claude's", source: "extension" as const }] : [{ name: "pi-prompt", source: "prompt" as const }],
    );
    const { newChatHarness } = await import("@glade/app-core/state/harnesses");
    newChatHarness.value = id === "pi" ? null : id;
    vi.mocked(api.createWorkspace).mockReturnValueOnce(new Promise(() => {}));
  }

  afterEach(async () => {
    const { newChatHarness } = await import("@glade/app-core/state/harnesses");
    newChatHarness.value = null;
    harnesses.value = null;
    const { resetNewChatModes } = await import("./new-chat-modes");
    resetNewChatModes();
    const { resetFolderCommands } = await import("./slash/folder-commands");
    resetFolderCommands();
    vi.mocked(folderApi.getFolderPermissionModes).mockReset();
    vi.mocked(folderApi.listFolderCommands).mockReset();
  });

  it("preselects the agent's default mode, cycles with Shift+Tab and starts the chat in the picked one", async () => {
    await pickAgent("claude");
    renderAt(<Composer projectId="p1" />);
    await waitFor(() => expect(pill()?.getAttribute("aria-label")).toBe("Permission mode: Default"));
    expect(vi.mocked(folderApi.getFolderPermissionModes).mock.calls[0]!.slice(0, 3)).toEqual(["p1", "claude", { provider: "anthropic", id: "haiku" }]);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
    fireEvent.keyDown(box, { key: "Tab", shiftKey: true });
    expect(pill()?.getAttribute("aria-label")).toBe("Permission mode: Plan mode");
    expect(api.setPermissionMode).not.toHaveBeenCalled(); // no chat yet
    fireEvent.input(box, { target: { value: "Plan it" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ harness: "claude", permissionMode: "plan", prompt: "Plan it" })));
  });

  it("sends no mode when the agent's own default is kept", async () => {
    await pickAgent("claude", "acceptEdits");
    renderAt(<Composer projectId="p1" />);
    await waitFor(() => expect(pill()?.getAttribute("aria-label")).toBe("Permission mode: Accept edits"));
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "Hi" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalled());
    expect(vi.mocked(api.createWorkspace).mock.calls[0]![0]).not.toHaveProperty("permissionMode");
  });

  it("has no pill for agents without modes, and lists the picked agent's folder commands", async () => {
    await pickAgent("pi");
    renderAt(<Composer projectId="p1" />);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "/" } });
    await waitFor(() => expect(screen.getAllByRole("option").map((o) => o.textContent).join("|")).toMatch(/pi-prompt/));
    expect(pill()).toBeNull();
    expect(folderApi.getFolderPermissionModes).not.toHaveBeenCalled();
    cleanup();

    // Another agent: its own commands (I-185), not the default agent's.
    await pickAgent("claude");
    renderAt(<Composer projectId="p1" />);
    const box2 = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box2, { target: { value: "/" } });
    await waitFor(() => expect(screen.getByRole("option", { name: /security-review/ })).toBeTruthy());
    expect(screen.queryByRole("option", { name: /pi-prompt/ })).toBeNull();
    expect(vi.mocked(folderApi.listFolderCommands).mock.lastCall).toEqual(["p1", false, undefined, "claude"]);
  });
});

describe("Composer @ file mentions", () => {
  const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
  const typeAt = (value: string) => {
    box().value = value;
    box().setSelectionRange(value.length, value.length);
    fireEvent.input(box(), { target: { value } });
  };
  const files = () => screen.queryAllByRole("option").map((o) => o.getAttribute("aria-label"));

  it("opens after @, navigates with arrows, inserts with Enter, closes on Escape", async () => {
    renderAt(<Composer projectId="p1" />);
    typeAt("look at @comp");
    await waitFor(() => expect(files()).toEqual(["apps/web/Composer.tsx", "src/", "my docs/read me.md"]));
    expect(folderApi.searchFiles).toHaveBeenLastCalledWith("p1", "comp", undefined, undefined);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("look at @apps/web/Composer.tsx ");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(api.createWorkspace).not.toHaveBeenCalled();

    // Folders complete stepwise; quoted paths with spaces.
    typeAt("@s");
    await waitFor(() => expect(files().length).toBe(3));
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "Tab" });
    expect(box().value).toBe("@src/");
    await waitFor(() => expect(files()).toEqual(["src/app.ts"]));
    typeAt("x @m");
    await waitFor(() => expect(files().length).toBe(3));
    fireEvent.keyDown(box(), { key: "ArrowUp" });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe('x @"my docs/read me.md" ');

    typeAt("@c");
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeNull());
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("doesn't open for @ inside a word (e.g. an email address)", async () => {
    renderAt(<Composer projectId="p1" />);
    typeAt("mail me@example.com");
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("parseShellInput (I-076)", () => {
  it("! shares, !! doesn't, anything else is a message", () => {
    expect(parseShellInput("!ls -la")).toEqual({ command: "ls -la", shareWithAgent: true });
    expect(parseShellInput("  ! git status ")).toEqual({ command: "git status", shareWithAgent: true });
    expect(parseShellInput("!!echo secret")).toEqual({ command: "echo secret", shareWithAgent: false });
    expect(parseShellInput("!")).toEqual({ command: "", shareWithAgent: true });
    expect(parseShellInput("!!")).toEqual({ command: "", shareWithAgent: false });
    expect(parseShellInput("hello!")).toBeNull();
    expect(parseShellInput("/compact")).toBeNull();
  });
});

describe("Composer shell mode (I-076)", () => {
  const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;

  it("runs !cmd (shared) and !!cmd (not shared) instead of sending, even while running", async () => {
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    fireEvent.input(box(), { target: { value: "!ls" } });
    expect(screen.getByText("Run a command — shared with the agent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run command" })).toBeTruthy();
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(api.runShell).toHaveBeenCalledWith("c1", { command: "ls", shareWithAgent: true }));
    expect(box().value).toBe("");

    fireEvent.input(box(), { target: { value: "!!echo secret" } });
    expect(screen.getByText("Run a command — not shared with the agent")).toBeTruthy();
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(api.runShell).toHaveBeenCalledWith("c1", { command: "echo secret", shareWithAgent: false }));
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("doesn't run an empty command and restores the text when it fails", async () => {
    readyChat("c1");
    renderAt(<Composer chatId="c1" />);
    fireEvent.input(box(), { target: { value: "!! " } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(api.runShell).not.toHaveBeenCalled();
    vi.mocked(api.runShell).mockRejectedValueOnce(new Error("nope"));
    fireEvent.input(box(), { target: { value: "!false" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    await waitFor(() => expect(box().value).toBe("!false"));
  });

  it("keeps the @ menu closed in shell mode", async () => {
    readyChat("c1");
    renderAt(<Composer chatId="c1" />);
    box().value = "!cat @comp";
    box().setSelectionRange(10, 10);
    fireEvent.input(box(), { target: { value: "!cat @comp" } });
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("is plain text when the harness can't run commands", async () => {
    harnesses.value = [{ id: "fake", label: "Fake", isDefault: true, capabilities: { ...ALL_CAPS, shell: false } }];
    try {
      readyChat("c1");
      renderAt(<Composer chatId="c1" />);
      fireEvent.input(box(), { target: { value: "!ls" } });
      expect(screen.queryByText("Run a command — shared with the agent")).toBeNull();
      fireEvent.keyDown(box(), { key: "Enter" });
      await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("c1", { text: "!ls", images: undefined, behavior: undefined }));
      expect(api.runShell).not.toHaveBeenCalled();
    } finally {
      harnesses.value = null;
    }
  });

  it("isn't offered in the new-chat composer (no chat folder session yet)", () => {
    renderAt(<Composer projectId="p1" />);
    fireEvent.input(box(), { target: { value: "!ls" } });
    expect(screen.queryByText("Run a command — shared with the agent")).toBeNull();
  });
});
