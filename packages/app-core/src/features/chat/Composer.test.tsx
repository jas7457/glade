import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, emptyTranscript, type CreateWorkspaceResponse, type ModelInfo } from "@glade/protocol";
import { TooltipProvider } from "@glade/app-core/ui";
import { harnessDefaults, models, resetAgentDefaults, sessions, settings, workspacesById } from "@glade/app-core/state/store";
import { makeSession, makeWorkspace } from "@glade/app-core/test/fixtures";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { parseShellInput, sendKeyModifiers } from "./composer-utils";
import { sendMenuModes, sendModeFor, type SendModeInput } from "./send-mode";
import { MODIFIER_SHOW_DELAY_MS } from "./use-held-modifiers";
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
    askSideQuestion: vi.fn(async () => ({ id: "side-1" })),
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

const key = (k: Partial<Parameters<typeof sendKeyModifiers>[0]>) => ({ key: "Enter", shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...k });

describe("sendKeyModifiers (I-153, I-200)", () => {
  it("↩ sends with the held modifiers (⌘ or Ctrl, ⌥); ⇧↩ is a new line", () => {
    expect(sendKeyModifiers(key({}))).toEqual({ meta: false, alt: false });
    expect(sendKeyModifiers(key({ metaKey: true }))).toEqual({ meta: true, alt: false });
    expect(sendKeyModifiers(key({ ctrlKey: true }))).toEqual({ meta: true, alt: false });
    expect(sendKeyModifiers(key({ altKey: true }))).toEqual({ meta: false, alt: true });
    expect(sendKeyModifiers(key({ altKey: true, metaKey: true }))).toEqual({ meta: true, alt: true });
    expect(sendKeyModifiers(key({ shiftKey: true }))).toBeNull();
    expect(sendKeyModifiers(key({ shiftKey: true, metaKey: true }))).toBeNull();
    expect(sendKeyModifiers(key({ key: "a" }))).toBeNull();
  });
  it("ignores keys during IME composition", () => {
    expect(sendKeyModifiers(key({ isComposing: true }))).toBeNull();
    expect(sendKeyModifiers(key({ keyCode: 229 }))).toBeNull();
    expect(sendKeyModifiers(key({ keyCode: 229, metaKey: true }))).toBeNull();
  });
});

describe("sendModeFor (I-200)", () => {
  const base: SendModeInput = { running: false, steering: true, sideQuestions: true, shellInput: false, hasText: true, hasAttachments: false, command: null, meta: false, alt: false };
  const mode = (over: Partial<SendModeInput>) => sendModeFor({ ...base, ...over });
  const NO_MODS = { meta: false, alt: false };
  const META = { meta: true, alt: false };
  const ALT = { meta: false, alt: true };
  const BOTH = { meta: true, alt: true };

  it("idle: Send, whatever is held", () => {
    for (const mods of [NO_MODS, META, ALT, BOTH]) {
      expect(mode({ ...mods }).mode).toBe("send");
      expect(mode({ ...mods, steering: false, sideQuestions: false }).mode).toBe("send");
    }
    expect(mode({}).behavior).toBe("steer");
    expect(mode({}).label).toBe("Send");
  });

  it("running, harness that steers: ↩ Steer · ⌘ Follow-up · ⌥ Ask Aside (⌥ wins)", () => {
    const running = { running: true };
    expect(mode({ ...running })).toMatchObject({ mode: "steer", behavior: "steer", label: "Steer", enabled: true });
    expect(mode({ ...running }).tooltip).toContain("⌥ to ask aside");
    expect(mode({ ...running, ...META })).toMatchObject({ mode: "followUp", behavior: "followUp", label: "Send follow-up" });
    expect(mode({ ...running, ...ALT })).toMatchObject({ mode: "askAside", label: "Ask Aside", enabled: true });
    expect(mode({ ...running, ...BOTH }).mode).toBe("askAside");
  });

  it("⌥ without side questions changes nothing", () => {
    expect(mode({ running: true, sideQuestions: false, ...ALT }).mode).toBe("steer");
    expect(mode({ running: true, sideQuestions: false }).tooltip).not.toContain("⌥");
    expect(mode({ running: true, sideQuestions: false, ...BOTH }).mode).toBe("followUp");
    expect(mode({ running: true, steering: false, sideQuestions: false, ...ALT }).mode).toBe("queue");
  });

  it("running, harness without steering: ↩ and ⌘↩ queue · ⌥ Ask Aside", () => {
    const running = { running: true, steering: false };
    expect(mode({ ...running })).toMatchObject({ mode: "queue", label: "Queue message", behavior: "steer" });
    expect(mode({ ...running, ...META }).mode).toBe("queue");
    expect(mode({ ...running, ...ALT }).mode).toBe("askAside");
    expect(mode({ ...running }).tooltip).toContain("hold ⌥ to ask aside");
  });

  it("Ask Aside needs text: attachments alone show it disabled", () => {
    expect(mode({ running: true, ...ALT, hasText: false, hasAttachments: true })).toMatchObject({ mode: "askAside", enabled: false });
    expect(mode({ running: true, hasText: false, hasAttachments: true })).toMatchObject({ mode: "steer", enabled: true });
  });

  it("nothing to send: the mode still shows, disabled", () => {
    const empty = { hasText: false, hasAttachments: false };
    expect(mode({ ...empty })).toMatchObject({ mode: "send", enabled: false });
    expect(mode({ ...empty, running: true })).toMatchObject({ mode: "steer", enabled: false });
    expect(mode({ ...empty, running: true, ...META })).toMatchObject({ mode: "followUp", enabled: false });
    expect(mode({ ...empty, running: true, steering: false })).toMatchObject({ mode: "queue", enabled: false });
    expect(mode({ ...empty, running: true, ...ALT })).toMatchObject({ mode: "askAside", enabled: false });
    expect(mode({ ...empty, shellInput: true })).toMatchObject({ mode: "runCommand", enabled: false });
  });

  it("shell input: Run command, modifiers ignored", () => {
    for (const running of [false, true]) {
      for (const mods of [NO_MODS, META, ALT, BOTH]) {
        expect(mode({ running, shellInput: true, ...mods })).toMatchObject({ mode: "runCommand", label: "Run command", enabled: true });
      }
    }
  });

  it("typed slash commands show what ↩ does with them, modifiers ignored", () => {
    for (const running of [false, true]) {
      for (const mods of [NO_MODS, META, ALT]) {
        expect(mode({ running, ...mods, command: { kind: "btw" } }).mode).toBe("askAside");
        expect(mode({ running, ...mods, command: { kind: "builtin", name: "compact" } })).toMatchObject({ mode: "runBuiltin", label: "Run /compact", enabled: true });
        expect(mode({ running, ...mods, command: { kind: "savedPrompt", name: "review" } })).toMatchObject({ mode: "insertPrompt", label: "Insert prompt" });
      }
    }
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

describe("sendMenuModes (I-200: Send's right-click menu)", () => {
  const base: Omit<SendModeInput, "meta" | "alt"> = { running: false, steering: true, sideQuestions: true, shellInput: false, hasText: true, hasAttachments: false, command: null };
  const menu = (over: Partial<typeof base> = {}) =>
    sendMenuModes({ ...base, ...over }).map((m) => [m.menuLabel, m.shortcut, m.enabled]);

  it("idle: just Send", () => {
    expect(menu()).toEqual([["Send", "↩", true]]);
    expect(menu({ hasText: false })).toEqual([["Send", "↩", false]]);
  });
  it("running: Steer / Send as Follow-up / Ask Aside, with their keys", () => {
    expect(menu({ running: true })).toEqual([
      ["Steer", "↩", true],
      ["Send as Follow-up", "⌘↩", true],
      ["Ask Aside", "⌥↩", true],
    ]);
    // Attachments only: Ask Aside can't.
    expect(menu({ running: true, hasText: false, hasAttachments: true })).toEqual([
      ["Steer", "↩", true],
      ["Send as Follow-up", "⌘↩", true],
      ["Ask Aside", "⌥↩", false],
    ]);
    expect(menu({ running: true, sideQuestions: false })).toEqual([
      ["Steer", "↩", true],
      ["Send as Follow-up", "⌘↩", true],
    ]);
  });
  it("without steering: Queue Message and Ask Aside", () => {
    expect(menu({ running: true, steering: false })).toEqual([
      ["Queue Message", "↩", true],
      ["Ask Aside", "⌥↩", true],
    ]);
  });
  it("shell input and typed commands: the one thing ↩ does", () => {
    expect(menu({ running: true, shellInput: true })).toEqual([["Run Command", "↩", true]]);
    expect(menu({ running: true, command: { kind: "builtin", name: "compact" } })).toEqual([["Run /compact", "↩", true]]);
    expect(menu({ command: { kind: "btw" } })).toEqual([["Ask Aside", "↩", true]]);
  });
  it("each item carries the modifiers that pick it", () => {
    expect(sendMenuModes({ ...base, running: true }).map((m) => m.mods)).toEqual([
      { meta: false, alt: false },
      { meta: true, alt: false },
      { meta: false, alt: true },
    ]);
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
    // IME composition: nothing sent.
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true, keyCode: 229 });
    expect(api.prompt).not.toHaveBeenCalled();
    expect(box.value).toBe("line");

    // ↩: send (steer while running).
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "line", images: undefined, behavior: choice("steer") }));
    // ⌥↩ without side questions: like ↩ (I-200: ⌥ changes nothing then).
    type("alt");
    fireEvent.keyDown(box, { key: "Enter", altKey: true });
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "alt", images: undefined, behavior: choice("steer") }));
    // ⌘↩ / Ctrl↩: follow-up while running, a plain send when idle.
    type("later");
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "later", images: undefined, behavior: choice("followUp") }));
    type("ctrl");
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "ctrl", images: undefined, behavior: choice("followUp") }));
    expect(api.prompt).toHaveBeenCalledTimes(4);
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
    const label = () => button().getAttribute("aria-label");
    expect(label()).toBe("Steer");
    expect(button().dataset.sendBehavior).toBe("steer");
    const steerIcon = button().innerHTML;
    const classes = button().className;

    // Shown after a short hold (I-200: quick ⌘ shortcuts don't flash it).
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    expect(label()).toBe("Steer");
    await waitFor(() => expect(label()).toBe("Send follow-up"));
    expect(button().dataset.sendBehavior).toBe("followUp");
    expect(button().innerHTML).not.toBe(steerIcon);
    expect(button().className).toBe(classes); // same size, slot and colour
    // Released: back at once.
    fireEvent.keyUp(window, { key: "Meta", metaKey: false });
    expect(label()).toBe("Steer");
    expect(button().innerHTML).toBe(steerIcon);

    // The keyup can get lost (⌘Tab): blur and hiding the window reset it.
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    await waitFor(() => expect(label()).toBe("Send follow-up"));
    fireEvent.blur(window);
    expect(label()).toBe("Steer");
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    await waitFor(() => expect(label()).toBe("Send follow-up"));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    expect(label()).toBe("Steer");
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    // Clicking while ⌘ is held sends a follow-up; a plain click steers.
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    await waitFor(() => expect(label()).toBe("Send follow-up"));
    fireEvent.click(button());
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "after that", images: undefined, behavior: "followUp" }));
    fireEvent.keyUp(window, { key: "Meta", metaKey: false });
    fireEvent.input(box, { target: { value: "now" } });
    fireEvent.click(button());
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "now", images: undefined, behavior: "steer" }));
    // A ⌘-click right away (before the icon swaps) is a follow-up too.
    fireEvent.input(box, { target: { value: "quick" } });
    fireEvent.click(button(), { metaKey: true });
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "quick", images: undefined, behavior: "followUp" }));
  });

  it("a quick ⌘ shortcut doesn't flash the follow-up icon", async () => {
    setSteering(true);
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    fireEvent.input(screen.getByRole("textbox", { name: "Message" }), { target: { value: "x" } });
    const label = () => screen.getByRole("button", { name: /^(Steer|Send follow-up)$/ }).getAttribute("aria-label");
    // ⌘K: the K arrives before the delay is up, and ⌘ stays hidden while it's held.
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await new Promise((r) => setTimeout(r, MODIFIER_SHOW_DELAY_MS + 60));
    expect(label()).toBe("Steer");
    fireEvent.keyUp(window, { key: "k", metaKey: true });
    await new Promise((r) => setTimeout(r, MODIFIER_SHOW_DELAY_MS + 60));
    expect(label()).toBe("Steer");
    // Released and held again: shows.
    fireEvent.keyUp(window, { key: "Meta", metaKey: false });
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    await waitFor(() => expect(label()).toBe("Send follow-up"));
    fireEvent.keyUp(window, { key: "Meta", metaKey: false });
    expect(label()).toBe("Steer");
  });

  it("the button doesn't change with ⌘ when idle or without steering", async () => {
    setSteering(false);
    const store = readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(box.placeholder).toBe("Queue a message…");
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    await new Promise((r) => setTimeout(r, MODIFIER_SHOW_DELAY_MS + 60));
    expect(screen.getByRole("button", { name: "Queue message" })).toBeTruthy();
    fireEvent.keyUp(window, { key: "Meta", metaKey: false });
    setSteering(true);
    store.state.value = { ...store.state.value, isRunning: false };
    await waitFor(() => expect(box.placeholder).toBe("Ask anything…"));
    fireEvent.keyDown(window, { key: "Meta", metaKey: true });
    fireEvent.keyDown(window, { key: "Alt", metaKey: true, altKey: true });
    await new Promise((r) => setTimeout(r, MODIFIER_SHOW_DELAY_MS + 60));
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(box.placeholder).toBe("Ask anything…");
  });
});

describe("one Send button for every mode (I-200)", () => {
  const setCaps = (caps: Partial<typeof ALL_CAPS & { sideQuestions: boolean }>) => {
    harnesses.value = [{ id: "fake", label: "Fake", isDefault: true, capabilities: { ...ALL_CAPS, sideQuestions: true, ...caps } }];
  };
  afterEach(() => {
    harnesses.value = null;
  });
  const sendButton = () => screen.getByRole("button", { name: /^(Send|Steer|Send follow-up|Queue message|Ask Aside|Run command|Run \/\w+|Insert prompt)$/ }) as HTMLButtonElement;
  const holdKey = async (key: "Meta" | "Alt") => {
    fireEvent.keyDown(window, { key, metaKey: key === "Meta", altKey: key === "Alt" });
    await new Promise((r) => setTimeout(r, MODIFIER_SHOW_DELAY_MS + 60));
  };
  const release = (key: "Meta" | "Alt") => fireEvent.keyUp(window, { key, metaKey: false, altKey: false });

  it("no separate Ask Aside button; ⌥ turns Send violet into Ask Aside, with its own icon", async () => {
    setCaps({});
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    expect(box.placeholder).toBe("↩ steer · ⌘↩ follow-up · ⌥↩ ask aside");
    fireEvent.input(box, { target: { value: "which file?" } });
    expect(screen.getAllByRole("button").filter((b) => /ask aside/i.test(b.getAttribute("aria-label") ?? ""))).toHaveLength(0);
    const icons = new Set<string>();
    expect(sendButton().getAttribute("aria-label")).toBe("Steer");
    icons.add(sendButton().innerHTML);
    await holdKey("Meta");
    expect(sendButton().getAttribute("aria-label")).toBe("Send follow-up");
    icons.add(sendButton().innerHTML);
    release("Meta");
    await holdKey("Alt");
    expect(sendButton().getAttribute("aria-label")).toBe("Ask Aside");
    expect(sendButton().dataset.sendBehavior).toBe("askAside");
    expect(sendButton().getAttribute("data-agent-color")).toBe("violet");
    expect(sendButton().className).toContain("bg-agent");
    icons.add(sendButton().innerHTML);
    expect(icons.size).toBe(3);
    // ⌥-click asks aside.
    fireEvent.click(sendButton());
    await waitFor(() => expect(api.askSideQuestion).toHaveBeenCalledWith("c1", "which file?"));
    expect(api.prompt).not.toHaveBeenCalled();
    expect(box.value).toBe("");
    // Nothing typed: still Ask Aside, disabled.
    expect(sendButton().getAttribute("aria-label")).toBe("Ask Aside");
    expect(sendButton().disabled).toBe(true);
    release("Alt");
    expect(sendButton().getAttribute("aria-label")).toBe("Steer");
    expect(sendButton().getAttribute("data-agent-color")).toBeNull();
  });

  it("an ⌥-click asks aside before the icon swaps; ⌥↩ too", async () => {
    setCaps({});
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "one" } });
    fireEvent.click(sendButton(), { altKey: true });
    await waitFor(() => expect(api.askSideQuestion).toHaveBeenLastCalledWith("c1", "one"));
    fireEvent.input(box, { target: { value: "two" } });
    fireEvent.keyDown(box, { key: "Enter", altKey: true, metaKey: true }); // ⌥ wins over ⌘
    await waitFor(() => expect(api.askSideQuestion).toHaveBeenLastCalledWith("c1", "two"));
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("attachments only: ⌥ shows Ask Aside disabled; ⌥↩ does nothing", async () => {
    setCaps({});
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    const input = screen.getByTestId("attach-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "notes.txt", { type: "text/plain" })], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    await holdKey("Alt");
    expect(sendButton().getAttribute("aria-label")).toBe("Ask Aside");
    expect(sendButton().disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key: "Enter", altKey: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(api.askSideQuestion).not.toHaveBeenCalled();
    expect(api.prompt).not.toHaveBeenCalled();
    release("Alt");
  });

  it("without steering: Queue message (its own icon) for ↩ and ⌘; ⌥ Ask Aside", async () => {
    setCaps({ steering: false });
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    fireEvent.input(screen.getByRole("textbox", { name: "Message" }), { target: { value: "hi" } });
    expect(sendButton().getAttribute("aria-label")).toBe("Queue message");
    expect(sendButton().dataset.sendBehavior).toBe("queue");
    const queueIcon = sendButton().innerHTML;
    await holdKey("Meta");
    expect(sendButton().getAttribute("aria-label")).toBe("Queue message");
    release("Meta");
    await holdKey("Alt");
    expect(sendButton().getAttribute("aria-label")).toBe("Ask Aside");
    release("Alt");
    // Queue looks different from idle Send.
    const store = getChatSession("c1");
    store.state.value = { ...store.state.value, isRunning: false };
    await waitFor(() => expect(sendButton().getAttribute("aria-label")).toBe("Send"));
    expect(sendButton().innerHTML).not.toBe(queueIcon);
  });

  it("idle Send and Steer have different icons", async () => {
    setCaps({});
    const store = readyChat("c1", false);
    renderAt(<Composer chatId="c1" />);
    fireEvent.input(screen.getByRole("textbox", { name: "Message" }), { target: { value: "hi" } });
    expect(sendButton().getAttribute("aria-label")).toBe("Send");
    expect(sendButton().dataset.sendBehavior).toBe("send");
    const sendIcon = sendButton().innerHTML;
    store.state.value = { ...store.state.value, isRunning: true };
    await waitFor(() => expect(sendButton().getAttribute("aria-label")).toBe("Steer"));
    expect(sendButton().innerHTML).not.toBe(sendIcon);
  });

  it("shell input: Run command in the shell tone, modifiers ignored", async () => {
    setCaps({});
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "!ls" } });
    expect(sendButton().getAttribute("aria-label")).toBe("Run command");
    expect(sendButton().getAttribute("data-tone")).toBe("shell");
    await holdKey("Alt");
    expect(sendButton().getAttribute("aria-label")).toBe("Run command");
    fireEvent.keyDown(box, { key: "Enter", altKey: true });
    await waitFor(() => expect(api.runShell).toHaveBeenCalledWith("c1", { command: "ls", shareWithAgent: true }));
    release("Alt");
  });

  it("right-clicking Send lists the modes that apply now; picking one sends that way", async () => {
    setCaps({});
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "after this" } });
    fireEvent.contextMenu(sendButton());
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Steer↩", "Send as Follow-up⌘↩", "Ask Aside⌥↩"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Send as Follow-up/ }));
    await waitFor(() => expect(api.prompt).toHaveBeenLastCalledWith("c1", { text: "after this", images: undefined, behavior: "followUp" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // Ask Aside from the menu.
    fireEvent.input(box, { target: { value: "quick q" } });
    fireEvent.contextMenu(sendButton());
    fireEvent.click(await screen.findByRole("menuitem", { name: /Ask Aside/ }));
    await waitFor(() => expect(api.askSideQuestion).toHaveBeenCalledWith("c1", "quick q"));
  });

  it("the menu disables what can't be sent (attachments only: Ask Aside); idle it's just Send", async () => {
    setCaps({});
    const store = readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    const input = screen.getByTestId("attach-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [new File(["x"], "notes.txt", { type: "text/plain" })], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.contextMenu(sendButton());
    const aside = await screen.findByRole("menuitem", { name: /Ask Aside/ });
    expect(aside.getAttribute("aria-disabled") ?? aside.getAttribute("data-disabled")).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: /^Steer/ }).hasAttribute("data-disabled")).toBe(false);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    store.state.value = { ...store.state.value, isRunning: false };
    await waitFor(() => expect(sendButton().getAttribute("aria-label")).toBe("Send"));
    fireEvent.contextMenu(sendButton());
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Send↩"]);
  });

  it("a typed slash command shows what ↩ does with it while running", async () => {
    setCaps({});
    readyChat("c1", true);
    renderAt(<Composer chatId="c1" />);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "/btw is it done?" } });
    expect(sendButton().getAttribute("aria-label")).toBe("Ask Aside");
    fireEvent.input(box, { target: { value: "/compact keep the plan" } });
    expect(sendButton().getAttribute("aria-label")).toBe("Run /compact");
    expect(sendButton().dataset.sendBehavior).toBe("runBuiltin");
    await holdKey("Meta");
    expect(sendButton().getAttribute("aria-label")).toBe("Run /compact");
    release("Meta");
    // Not a Glade command: sent to the agent like text (steers).
    fireEvent.input(box, { target: { value: "/skill:review now" } });
    expect(sendButton().getAttribute("aria-label")).toBe("Steer");
  });
});

describe("Composer (new chat)", () => {
  it("creates the chat with the default model/thinking and navigates to it", async () => {
    harnesses.value = [{ id: "pi", label: "pi", isDefault: true, capabilities: ALL_CAPS }];
    settings.value = {
      ...defaultSettings(),
      models: { ...defaultSettings().models, agents: { pi: { defaultModel: { provider: "anthropic", id: "haiku" }, defaultThinkingLevel: "xhigh" } } },
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
    harnesses.value = null;
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

describe("Composer (new chat: the picked agent's own model settings, I-198)", () => {
  const PI_MODELS: ModelInfo[] = MODELS.map((m) => ({ ...m, harness: "pi" }));
  const CLAUDE_MODELS: ModelInfo[] = [
    { provider: "anthropic", id: "sonnet", name: "Sonnet", thinkingLevels: ["off", "low", "medium", "high"], input: ["text"], harness: "claude" },
    { provider: "anthropic", id: "opus", name: "Opus", thinkingLevels: ["off", "low", "medium", "high"], input: ["text"], harness: "claude" },
  ];

  beforeEach(async () => {
    models.value = [...PI_MODELS, ...CLAUDE_MODELS];
    harnesses.value = [
      { id: "pi", label: "pi", isDefault: true, capabilities: ALL_CAPS },
      { id: "claude", label: "Claude Code", isDefault: false, capabilities: ALL_CAPS },
    ];
    (await import("@glade/app-core/state/harnesses")).newChatHarness.value = "claude";
    resetAgentDefaults();
    vi.mocked(api.createWorkspace).mockReturnValueOnce(new Promise(() => {}));
  });
  afterEach(async () => {
    (await import("@glade/app-core/state/harnesses")).newChatHarness.value = null;
    harnesses.value = null;
    vi.mocked(folderApi.getHarnessDefaults).mockReset();
    vi.mocked(folderApi.getHarnessDefaults).mockImplementation(async () => ({ model: null, thinkingLevel: null }));
  });

  it("uses that agent's default model and thinking, never the default agent's", async () => {
    settings.value = {
      ...defaultSettings(),
      models: {
        quickTasks: null,
        agents: { pi: { defaultModel: { provider: "anthropic", id: "haiku" } }, claude: { defaultModel: { provider: "anthropic", id: "opus" }, defaultThinkingLevel: "low" } },
      },
    };
    renderAt(<Composer projectId="p1" />);
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Opus");
    expect(screen.getByRole("button", { name: "Thinking level" }).textContent).toContain("Low");
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "Hi" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(api.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ harness: "claude", model: { provider: "anthropic", id: "opus" }, thinkingLevel: "low" })),
    );
  });

  it('"Default" is the agent\'s own default, asked for with ?harness= (and sends no model)', async () => {
    vi.mocked(folderApi.getHarnessDefaults).mockImplementation(async (_r, _via, harness) =>
      harness === "claude" ? { model: { provider: "anthropic", id: "opus" }, thinkingLevel: "high" } : { model: null, thinkingLevel: null },
    );
    renderAt(<Composer projectId="p1" />);
    // Before it answers: the agent's first model; then its own default (not the first).
    await waitFor(() => expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("Opus"));
    expect(screen.getByRole("button", { name: "Thinking level" }).textContent).toContain("High");
    expect(vi.mocked(folderApi.getHarnessDefaults).mock.calls.some((c) => c[2] === "claude")).toBe(true);
    const box = screen.getByRole("textbox", { name: "Message" });
    fireEvent.input(box, { target: { value: "Hi" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ harness: "claude", model: null, thinkingLevel: "high" })));
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
