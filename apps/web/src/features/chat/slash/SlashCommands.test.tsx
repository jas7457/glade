import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { createMemoryRouter, RouterProvider } from "react-router";
import { defaultSessionState, defaultSettings, type ModelInfo, type SlashCommand } from "@glade/protocol";
import { TooltipProvider } from "@/ui";
import { models, sessions, settings, workspaces } from "@/state/store";
import { makeSession, makeWorkspace } from "@/test/fixtures";
import { getChatSession, resetChatSessions } from "@/state/chat-session";
import { harnesses } from "@/state/harnesses";
import { toasts } from "@/state/toasts";
import { Composer } from "../Composer";
import { resetFolderCommands } from "./folder-commands";
import { SettingsIndexRoute } from "@/features/settings";

vi.mock("@/lib/api", () => ({
  api: {
    createWorkspace: vi.fn(),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    getSession: vi.fn(() => new Promise(() => {})),
    setModel: vi.fn(async () => undefined),
    setThinkingLevel: vi.fn(async () => undefined),
    respondToUi: vi.fn(async () => undefined),
    updateWorkspace: vi.fn(async (id: string, body: { title: string }) => ({ id, title: body.title })),
    generateSessionTitle: vi.fn(async (id: string) => ({ title: "Fixing the login bug", session: { id } })),
    listCommands: vi.fn(async () => HARNESS),
    compact: vi.fn(async () => ({ tokensBefore: 150_000, tokensAfter: 32_000 })),
    exportSession: vi.fn(async () => ({ path: "/Users/me/Downloads/pi-session-x.html" })),
    revealFile: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/api-folder", () => ({
  listFolderCommands: vi.fn(async () => FOLDER),
  searchFiles: vi.fn(async () => ({ entries: [], truncated: false })),
  getHarnessDefaults: vi.fn(async () => ({ model: null, thinkingLevel: null })),
}));
vi.mock("@/lib/socket", () => ({ socket: { send: vi.fn(), watch: vi.fn(() => () => {}) } }));

const HARNESS: SlashCommand[] = [
  { name: "mcp", source: "extension", description: "Manage MCP servers" },
  { name: "skill:web-design", source: "skill", description: "Design websites" },
  { name: "fix-tests", source: "prompt", description: "Fix failing tests" },
];

/** Folder commands for the new-chat composer (a clash with a built-in name is dropped). */
const FOLDER: SlashCommand[] = [
  { name: "reply", source: "extension", description: "Reply" },
  { name: "cd", source: "extension", description: "Change directory" },
  { name: "compact", source: "extension", description: "Clashes with the built-in" },
  { name: "skill:web-design", source: "skill", description: "Design websites" },
];

const { api } = await import("@/lib/api");
const folderApi = await import("@/lib/api-folder");

const MODELS: ModelInfo[] = [
  { provider: "anthropic", id: "haiku", name: "Claude Haiku", thinkingLevels: ["off", "low", "medium", "high"], input: ["text"] },
  { provider: "openai", id: "mini", name: "GPT Mini", thinkingLevels: ["off"], input: ["text"] },
];

function renderAt(ui: preact.ComponentChildren) {
  const router = createMemoryRouter(
    [
      { path: "/", element: <TooltipProvider>{ui}</TooltipProvider> },
      { path: "/projects/:projectId", element: <div>project page</div> },
      { path: "/settings", element: <SettingsIndexRoute /> },
      { path: "/settings/:section", element: <div>settings page</div> },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

function readyChat(chatId: string, overrides: Partial<ReturnType<typeof defaultSessionState>> = {}) {
  const store = getChatSession(chatId);
  store.status.value = "ready";
  store.state.value = {
    ...defaultSessionState(),
    model: { provider: "anthropic", id: "haiku" },
    thinkingLevel: "medium",
    thinkingLevels: ["off", "low", "medium", "high"],
    ...overrides,
  };
  return store;
}

const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const type = (value: string) => fireEvent.input(box(), { target: { value } });
const key = (k: string, extra: Record<string, unknown> = {}) => fireEvent.keyDown(box(), { key: k, ...extra });
const options = () => screen.queryAllByRole("option").map((o) => o.textContent ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
  resetFolderCommands();
  settings.value = defaultSettings();
  models.value = MODELS;
  toasts.value = [];
  // Session "c1" is the only tab of workspace "w1" (different ids on purpose).
  workspaces.value = [makeWorkspace({ id: "w1" })];
  sessions.value = [makeSession({ id: "c1", workspaceId: "w1" })];
});

async function openChat() {
  readyChat("c1");
  renderAt(<Composer chatId="c1" />);
  await waitFor(() => expect(getChatSession("c1").commands.value).toEqual(HARNESS));
}

describe("slash menu", () => {
  it("opens on / with grouped built-ins, extensions, skills and prompts", async () => {
    await openChat();
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/");
    const groups = screen.getAllByRole("group").map((g) => g.getAttribute("aria-label"));
    expect(groups).toEqual(["Built-in", "Extensions", "Skills", "Prompts"]);
    expect(options().some((o) => o.includes("/compact") && o.includes("free up context"))).toBe(true);
    expect(options().some((o) => o.includes("/skill:web-design"))).toBe(true);
    expect(box().getAttribute("aria-expanded")).toBe("true");
  });

  it("filters by name and description; closes when nothing matches or args start", async () => {
    await openChat();
    type("/web");
    expect(options()).toEqual([expect.stringContaining("/skill:web-design")]);
    type("/failing");
    expect(options()).toEqual([expect.stringContaining("/fix-tests")]);
    type("/zzz");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/compact now");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("not a command /compact");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("moves with arrows (wrapping) and completes with Tab / Enter", async () => {
    await openChat();
    type("/");
    const selected = () => screen.getAllByRole("option").findIndex((o) => o.getAttribute("aria-selected") === "true");
    expect(selected()).toBe(0);
    key("ArrowDown");
    expect(selected()).toBe(1);
    key("ArrowUp");
    key("ArrowUp");
    expect(selected()).toBe(screen.getAllByRole("option").length - 1);
    type("/comp");
    key("Tab");
    expect(box().value).toBe("/compact ");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/mc");
    key("Enter");
    expect(box().value).toBe("/mcp ");
    expect(api.prompt).not.toHaveBeenCalled();
  });

  it("Escape closes the menu without stopping the agent; mouse click completes", async () => {
    readyChat("c1", { isRunning: true });
    renderAt(<Composer chatId="c1" />);
    await waitFor(() => expect(getChatSession("c1").commands.value).toEqual(HARNESS));
    type("/");
    key("Escape");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(api.abort).not.toHaveBeenCalled();
    type("");
    type("/sk");
    fireEvent.click(screen.getByRole("option", { name: /skill:web-design/ }));
    expect(box().value).toBe("/skill:web-design ");
  });

  it("is IME-safe: Enter/arrows during composition are left alone", async () => {
    await openChat();
    type("/comp");
    key("Enter", { isComposing: true });
    expect(box().value).toBe("/comp");
    key("Tab");
    expect(box().value).toBe("/compact ");
  });

  it("sends harness commands to the agent as a normal prompt", async () => {
    await openChat();
    type("/skill:web-design build a landing page");
    key("Enter");
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("c1", { text: "/skill:web-design build a landing page", images: undefined, behavior: undefined }));
  });

  it("an exact name + Enter in the menu runs it right away", async () => {
    await openChat();
    type("/mcp");
    key("Enter");
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("c1", expect.objectContaining({ text: "/mcp" })));
  });
});

describe("built-in commands", () => {
  it("/compact [instructions] compacts instead of sending, showing a working state", async () => {
    let finish!: () => void;
    vi.mocked(api.compact).mockImplementationOnce(() => new Promise((r) => (finish = () => r({ tokensBefore: 1, tokensAfter: 1 }))));
    await openChat();
    type("/compact keep the API decisions");
    key("Enter");
    await waitFor(() => expect(api.compact).toHaveBeenCalledWith("c1", "keep the API decisions"));
    expect(api.prompt).not.toHaveBeenCalled();
    expect(box().value).toBe("");
    expect(screen.getByText("Compacting context…")).toBeTruthy();
    await act(async () => finish());
    await waitFor(() => expect(getChatSession("c1").state.value.isCompacting).toBe(false));
  });

  it("/compact reports errors and clears the working state", async () => {
    vi.mocked(api.compact).mockRejectedValueOnce(new Error("Nothing to compact"));
    await openChat();
    type("/compact");
    key("Enter");
    await waitFor(() => expect(toasts.value.some((t) => t.message.includes("Nothing to compact"))).toBe(true));
    expect(getChatSession("c1").state.value.isCompacting).toBe(false);
  });

  it("/name renames; without a title it names the chat from the conversation (I-074)", async () => {
    let finish!: () => void;
    vi.mocked(api.generateSessionTitle).mockImplementationOnce(
      (id) => new Promise((r) => (finish = () => r({ title: "Fixing the login bug", session: { id } as never }))),
    );
    await openChat();
    type("/name ");
    key("Enter");
    await waitFor(() => expect(api.generateSessionTitle).toHaveBeenCalledWith("c1"));
    expect(toasts.value.some((t) => t.message === "Naming this chat…")).toBe(true);
    await act(async () => finish());
    await waitFor(() => expect(toasts.value.some((t) => t.message.includes("Renamed to “Fixing the login bug”"))).toBe(true));
    expect(toasts.value.some((t) => t.message === "Naming this chat…")).toBe(false);
    expect(box().value).toBe("");
    vi.mocked(api.generateSessionTitle).mockRejectedValueOnce(new Error("Nothing to name yet"));
    type("/name");
    key("Enter");
    await waitFor(() => expect(toasts.value.some((t) => t.message.includes("Nothing to name yet"))).toBe(true));
    expect(box().value).toBe("/name");
    type("/name Better title");
    key("Enter");
    await waitFor(() => expect(api.updateWorkspace).toHaveBeenCalledWith("w1", { title: "Better title" }));
  });

  it("/model <query> sets a unique match; /thinking <level> sets the level", async () => {
    await openChat();
    type("/model mini");
    key("Enter");
    await waitFor(() => expect(api.setModel).toHaveBeenCalledWith("c1", { provider: "openai", id: "mini" }));
    // Back to a reasoning model for /thinking.
    getChatSession("c1").state.value = { ...getChatSession("c1").state.value, thinkingLevels: ["off", "low", "high"] };
    type("/thinking high");
    key("Enter");
    await waitFor(() => expect(api.setThinkingLevel).toHaveBeenCalledWith("c1", "high"));
    type("/thinking ludicrous");
    key("Enter");
    await waitFor(() => expect(toasts.value.some((t) => t.message.includes("Unknown thinking level"))).toBe(true));
  });

  it("/model without a query opens the model picker", async () => {
    await openChat();
    type("/model ");
    key("Enter");
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /GPT Mini/ })).toBeTruthy());
  });

  it("/export shows the path with a Reveal action", async () => {
    await openChat();
    type("/export");
    key("Enter");
    await waitFor(() => expect(api.exportSession).toHaveBeenCalledWith("c1"));
    await waitFor(() => expect(toasts.value[0]?.message).toBe("/Users/me/Downloads/pi-session-x.html"));
    toasts.value[0]!.action!.onClick();
    expect(api.revealFile).toHaveBeenCalledWith("/Users/me/Downloads/pi-session-x.html");
  });

  it("/stats shows usage and cost", async () => {
    readyChat("c1", {
      contextUsage: { tokens: 42_100, contextWindow: 200_000, percent: 21.05 },
      sessionStats: { tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500 }, cost: 0.45 },
    });
    renderAt(<Composer chatId="c1" />);
    type("/stats");
    key("Enter");
    await waitFor(() => expect(toasts.value[0]?.message).toContain("42.1k / 200k tokens (21%)"));
    expect(toasts.value[0]?.message).toContain("$0.45");
  });

  it("/new and /settings navigate", async () => {
    workspaces.value = [makeWorkspace({ id: "w1", projectId: "p1" })];
    readyChat("c1");
    const router = renderAt(<Composer chatId="c1" />);
    type("/new");
    key("Enter");
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/p1"));
  });

  it("new-chat composer offers chat-independent built-ins + the folder's commands, A→Z", async () => {
    const router = renderAt(<Composer projectId="p1" />);
    await waitFor(() => expect(folderApi.listFolderCommands).toHaveBeenCalledWith("p1", false, undefined));
    type("/");
    await waitFor(() => expect(options().length).toBeGreaterThan(3));
    expect(options().map((o) => o.match(/^\/[a-z:-]+/)?.[0])).toEqual(["/model", "/settings", "/thinking", "/cd", "/reply", "/skill:web-design"]);
    type("/compact");
    expect(screen.queryByRole("listbox")).toBeNull();
    type("/settings");
    key("Enter");
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/general"));
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });
});

describe("harness capabilities (I-065)", () => {
  afterEach(() => {
    harnesses.value = null;
  });

  it("hides /compact and /export when the chat's harness can't do them", async () => {
    const all = { compact: true, exportHtml: true, steering: true, uiRequests: true, usageLimits: true, commands: true, subagents: true, shell: true };
    harnesses.value = [{ id: "fake", label: "Fake", isDefault: true, capabilities: { ...all, compact: false, exportHtml: false } }];
    await openChat();
    type("/");
    const names = options().map((o) => o.match(/^\/[a-z:-]+/)?.[0]);
    expect(names).not.toContain("/compact");
    expect(names).not.toContain("/export");
    expect(names).toContain("/stats");
    // Typed anyway: it goes to the agent as text instead of running the built-in.
    type("/compact");
    key("Escape");
    key("Enter");
    await waitFor(() => expect(api.prompt).toHaveBeenCalledWith("c1", expect.objectContaining({ text: "/compact" })));
    expect(api.compact).not.toHaveBeenCalled();
  });
});

describe("folder commands + hidden commands", () => {
  it("picking a folder command in a new chat starts the chat with it", async () => {
    vi.mocked(api.createWorkspace).mockReturnValueOnce(new Promise(() => {}));
    renderAt(<Composer projectId="p1" />);
    type("/");
    await waitFor(() => expect(options().some((o) => o.startsWith("/reply"))).toBe(true));
    type("/rep");
    key("Enter"); // completes "/reply "
    expect(box().value).toBe("/reply ");
    type("/reply hello");
    key("Enter");
    await waitFor(() => expect(api.createWorkspace).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", prompt: "/reply hello" })));
  });

  it("leaves hidden commands out of the menu but still runs them typed in full", async () => {
    settings.value = { ...defaultSettings(), slashCommands: { hidden: ["builtin:settings", "extension:mcp"] } };
    const router = renderAt(<Composer projectId="p1" />);
    type("/");
    await waitFor(() => expect(options().some((o) => o.startsWith("/cd"))).toBe(true));
    expect(options().some((o) => o.startsWith("/settings"))).toBe(false);
    type("/settings");
    key("Enter");
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/general"));
  });
});

describe("context meter", () => {
  it("is hidden without usage, shows usage with thresholds, dashed when unknown", async () => {
    readyChat("c1");
    renderAt(<Composer chatId="c1" />);
    expect(screen.queryByRole("button", { name: /Context usage/ })).toBeNull();
    act(() => {
      getChatSession("c1").state.value = { ...getChatSession("c1").state.value, contextUsage: { tokens: 170_000, contextWindow: 200_000, percent: 85 } };
    });
    const meter = screen.getByRole("button", { name: "Context usage: 170k / 200k tokens (85%)" });
    expect(meter.getAttribute("data-level")).toBe("warning");
    act(() => {
      getChatSession("c1").state.value = { ...getChatSession("c1").state.value, contextUsage: { tokens: null, contextWindow: 200_000, percent: null } };
    });
    expect(screen.getByRole("button", { name: /Context usage/ }).getAttribute("data-level")).toBe("unknown");
  });

  it("is not shown in the new-chat composer", () => {
    renderAt(<Composer projectId={null} />);
    expect(screen.queryByRole("button", { name: /Context usage/ })).toBeNull();
  });
});
