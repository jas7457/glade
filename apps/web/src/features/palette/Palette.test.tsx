import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";

vi.mock("@glade/app-core/lib/api", () => ({ api: { generateSessionTitle: vi.fn() }, request: vi.fn() }));
vi.mock("@glade/app-core/lib/api-search", () => ({
  searchChats: vi.fn(async (q: string) => ({ query: q, hits: [] })),
  askChats: vi.fn(),
}));
vi.mock("@glade/app-core/state/actions", () => ({
  renameWorkspace: vi.fn(async () => true),
  setChatPinned: vi.fn(async () => true),
  deleteChat: vi.fn(async () => true),
  updateSettings: vi.fn(async () => true),
  updateWorkspace: vi.fn(async () => true),
}));

import type { AskResponse, SearchHit } from "@glade/protocol";
import { api } from "@glade/app-core/lib/api";
import { askChats, searchChats } from "@glade/app-core/lib/api-search";
import { renameWorkspace, updateSettings } from "@glade/app-core/state/actions";
import { bookmarks, projects, sessions, workspaces } from "@glade/app-core/state/store";
import { toasts } from "@glade/app-core/state/toasts";
import { paletteOpen, sidebarCollapsed } from "@glade/app-core/state/ui";
import { useGlobalShortcuts, type ShortcutHandlers } from "@/app/shortcuts";
import { globalCommands } from "@/app/commands";
import type { RouteContext } from "@/app/paths";
import { makeWorkspace, makeProject, makeSession } from "@glade/app-core/test/fixtures";
import { pendingJump } from "@glade/app-core/features/chat/jump-to-message";
import { Palette } from "./Palette";

const noRoute: RouteContext = { workspaceId: null, projectId: null, isSettings: false, envId: null };

function renderPalette(route: RouteContext = noRoute) {
  const navigate = vi.fn();
  render(<Palette context={{ navigate, route }} />);
  return { navigate, input: () => screen.getByRole("combobox") };
}

const groups = (): [string | null, (string | null)[]][] =>
  screen.getAllByRole("group").map((g) => [g.getAttribute("aria-label"), within(g).getAllByRole("option").map((o) => o.textContent)]);
const selected = () => screen.getAllByRole("option").find((o) => o.getAttribute("aria-selected") === "true")?.textContent;
const type = (input: HTMLElement, value: string) => fireEvent.input(input, { target: { value } });

describe("Palette", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paletteOpen.value = true;
    sidebarCollapsed.value = false;
    projects.value = [makeProject({ id: "p1", name: "Alpha", sortOrder: 0 }), makeProject({ id: "p2", name: "Beta", sortOrder: 1 })];
    workspaces.value = [
      makeWorkspace({ id: "c1", projectId: "p1", title: "Fix login bug", lastActivityAt: 5 }),
      makeWorkspace({ id: "c2", projectId: null, title: "Old notes", lastActivityAt: 1 }),
      makeWorkspace({ id: "c3", projectId: "p2", title: "Needs review", lastActivityAt: 0, status: "unread", unread: true }),
    ];
  });

  it("lists chats (attention first, then recent), projects and actions for an empty query", () => {
    renderPalette();
    const [chatGroup, projectGroup, actionGroup] = groups();
    expect(chatGroup).toEqual(["Chats", ["Needs reviewBeta", "Fix login bugAlpha", "Old notes"]]);
    expect(projectGroup![0]).toBe("Projects");
    expect(projectGroup![1]![0]).toMatch(/^Alpha/);
    expect(actionGroup![0]).toBe("Actions");
    // Search-only and current-chat actions are hidden; shortcuts are shown on the right.
    expect(actionGroup![1]).toContain("New Chat⌘N");
    expect(actionGroup![1]).toContain("Toggle Sidebar⌘B");
    expect(actionGroup![1]!.some((t) => t?.startsWith("New Chat in"))).toBe(false);
    expect(actionGroup![1]!.some((t) => t?.startsWith("Rename"))).toBe(false);
    expect(selected()).toBe("Needs reviewBeta");
  });

  it("jumps to a chat by typing its title and pressing Enter", async () => {
    const { navigate, input } = renderPalette();
    type(input(), "login");
    expect(selected()).toBe("Fix login bugAlpha");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(paletteOpen.value).toBe(false);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/projects/p1/chats/c1"));
  });

  it("moves the highlight with the arrow keys (wrapping) and runs actions", async () => {
    const { input } = renderPalette();
    type(input(), "theme");
    // Shorter titles win ties.
    expect(groups()).toEqual([["Actions", ["Theme: Dark", "Theme: Auto", "Theme: Light"]]]);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(selected()).toBe("Theme: Auto");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(selected()).toBe("Theme: Light");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ appearance: { theme: "light" } }));
  });

  it("toggles the sidebar and shows an empty state", async () => {
    const { input } = renderPalette();
    type(input(), "zzzz");
    expect(screen.getByText("No results")).toBeTruthy();
    type(input(), "toggle side");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(sidebarCollapsed.value).toBe(true));
  });

  it("renames the current chat through a prompt", async () => {
    const { input } = renderPalette({ workspaceId: "c1", projectId: "p1", isSettings: false, envId: null });
    type(input(), "rename");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(paletteOpen.value).toBe(true);
    expect((input() as HTMLInputElement).value).toBe("Fix login bug");
    expect(screen.getByText("Rename Chat")).toBeTruthy();
    type(input(), "Fix OAuth login");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(renameWorkspace).toHaveBeenCalledWith("c1", "Fix OAuth login");
    expect(paletteOpen.value).toBe(false);
  });

  it("renames the current tab with AI (I-101) and reports failures", async () => {
    sessions.value = [makeSession({ id: "s1", workspaceId: "c1", kind: "main" })];
    const generate = vi.mocked(api.generateSessionTitle);
    generate.mockResolvedValueOnce({ title: "OAuth login", session: sessions.value[0]! });
    const { input } = renderPalette({ workspaceId: "c1", projectId: "p1", isSettings: false, envId: null });
    type(input(), "rename with ai");
    expect(selected()).toBe("Rename with AI");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(paletteOpen.value).toBe(false);
    await waitFor(() => expect(generate).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(toasts.value.some((t) => t.level === "success" && t.message.includes("OAuth login"))).toBe(true));

    generate.mockRejectedValueOnce(new Error("Nothing to name yet"));
    paletteOpen.value = true;
    await waitFor(() => screen.getByRole("combobox"));
    type(screen.getByRole("combobox"), "rename with ai");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(toasts.value.some((t) => t.level === "error" && t.message.includes("Nothing to name yet"))).toBe(true));
  });

  it("hides Rename with AI without a current chat", () => {
    const { input } = renderPalette();
    type(input(), "rename with ai");
    expect(screen.queryByText("Rename with AI")).toBeNull();
  });

  it("closes on Escape", () => {
    const { input } = renderPalette();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(paletteOpen.value).toBe(false);
  });
});

function hit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    workspaceId: "c2",
    sessionId: "s2",
    sessionKind: "main",
    title: "Old notes",
    workspaceTitle: "Old notes",
    projectId: null,
    project: null,
    snippet: { text: "…we fixed the null coupon bug", highlights: [[19, 25]] },
    matchedIn: "assistant",
    score: 3,
    updatedAt: 1,
    ...over,
  };
}

describe("Palette: message search and Ask (I-045/I-046)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paletteOpen.value = true;
    projects.value = [makeProject({ id: "p1", name: "Alpha", sortOrder: 0 })];
    workspaces.value = [
      makeWorkspace({ id: "c1", projectId: "p1", title: "Fix login bug", lastActivityAt: 5 }),
      makeWorkspace({ id: "c2", projectId: null, title: "Old notes", lastActivityAt: 1 }),
    ];
  });

  it("lists bookmarks of every chat in a Bookmarks group and opens the right tab at the message (I-203)", async () => {
    sessions.value = [
      makeSession({ id: "s1", workspaceId: "c1", kind: "main" }),
      makeSession({ id: "s2", workspaceId: "c2", kind: "main" }),
      makeSession({ id: "sub", workspaceId: "c2", kind: "subagent", parentSessionId: "s2" }),
    ];
    const bm = (id: string, sessionId: string, workspaceId: string, label: string, createdAt: number) => ({
      id,
      sessionId,
      workspaceId,
      message: { role: "assistant" as const, timestamp: createdAt * 10 },
      label,
      labelSource: "auto" as const,
      excerpt: `${label} and more`,
      createdAt,
    });
    bookmarks.value = [bm("b1", "s1", "c1", "Q3 revenue table", 1), bm("b2", "sub", "c2", "Agent findings", 2), bm("gone", "nope", "nope", "Orphan", 3)];
    const { navigate, input } = renderPalette();
    const group = () => within(screen.getByRole("group", { name: "Bookmarks" })).getAllByRole("option").map((o) => o.textContent);
    // Newest first; the chat (and project) as subtitle, the first line as detail; unknown chats skipped.
    expect(group()).toEqual(["Agent findingsOld notesAgent findings and more", "Q3 revenue tableFix login bug · AlphaQ3 revenue table and more"]);
    type(input(), "revenue");
    expect(selected()).toMatch(/^Q3 revenue table/);
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/projects/p1/chats/c1?tab=s1"));
    expect(pendingJump.value).toMatchObject({ sessionId: "s1", message: { role: "assistant", timestamp: 10 } });
    pendingJump.value = null;
    // A sub-agent's bookmark opens its parent's tab.
    paletteOpen.value = true;
    await waitFor(() => expect(screen.getByRole("combobox")).toBeTruthy());
    type(input(), "findings");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/chats/c2?tab=s2"));
    expect(pendingJump.value).toMatchObject({ sessionId: "sub" });
    pendingJump.value = null;
    bookmarks.value = [];
  });

  it("shows message hits with snippets under Chats and opens the hit's tab", async () => {
    vi.mocked(searchChats).mockResolvedValue({ query: "coupon", hits: [hit(), hit({ sessionId: "x", matchedIn: "title" })] });
    const { navigate, input } = renderPalette();
    type(input(), "coupon");
    await waitFor(() => expect(screen.getByRole("group", { name: "Messages" })).toBeTruthy());
    expect(searchChats).toHaveBeenCalledWith("coupon", 12);
    const rows = within(screen.getByRole("group", { name: "Messages" })).getAllByRole("option");
    expect(rows.map((r) => r.textContent)).toEqual(["Old notes…we fixed the null coupon bug"]); // title-only hits are dropped
    expect(rows[0]!.querySelector("b")?.textContent).toBe("coupon");
    fireEvent.click(rows[0]!);
    expect(navigate).toHaveBeenCalledWith("/chats/c2?tab=s2");
    expect(paletteOpen.value).toBe(false);
    expect(pendingJump.value).toBeNull(); // no anchor on this hit
  });

  it("opening a message hit asks the transcript to jump to the matched message (I-093)", async () => {
    pendingJump.value = null;
    const message = { role: "assistant", timestamp: 1234 } as const;
    vi.mocked(searchChats).mockResolvedValue({ query: "coupon", hits: [hit({ message })] });
    const { navigate, input } = renderPalette();
    type(input(), "coupon");
    await waitFor(() => expect(screen.getByRole("group", { name: "Messages" })).toBeTruthy());
    fireEvent.click(within(screen.getByRole("group", { name: "Messages" })).getByRole("option"));
    expect(navigate).toHaveBeenCalledWith("/chats/c2?tab=s2");
    expect(pendingJump.value).toMatchObject({ sessionId: "s2", message });
    pendingJump.value = null;
  });

  it("enters Ask mode with ? and opens a confident match directly", async () => {
    vi.mocked(askChats).mockResolvedValue({
      query: "q",
      confident: true,
      model: "anthropic/claude-haiku-4-5",
      matches: [
        { workspaceId: "c1", sessionId: "s1", sessionKind: "main", title: "Fix login bug", project: "Alpha", summary: null, reason: "r", updatedAt: 5, message: { role: "user", timestamp: 7 } },
      ],
    } satisfies AskResponse);
    const { navigate, input } = renderPalette();
    type(input(), "?the chat about signing in");
    expect(screen.getByText("Ask")).toBeTruthy();
    expect((input() as HTMLInputElement).value).toBe("the chat about signing in");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(askChats).toHaveBeenCalledWith("the chat about signing in");
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/projects/p1/chats/c1?tab=s1"));
    expect(paletteOpen.value).toBe(false);
    expect(pendingJump.value).toMatchObject({ sessionId: "s1", message: { role: "user", timestamp: 7 } });
    pendingJump.value = null;
  });

  it("Tab switches to Ask; unsure answers are listed with reasons; Backspace goes back", async () => {
    vi.mocked(askChats).mockResolvedValue({
      query: "q",
      confident: false,
      model: "m",
      matches: [
        { workspaceId: "c2", sessionId: "s2", sessionKind: "main", title: "Old notes", project: null, summary: null, reason: "Mentions coupons", updatedAt: 1 },
        { workspaceId: "c1", sessionId: "s1", sessionKind: "subagent", title: "Fix login bug", project: "Alpha", summary: "Login", reason: "", updatedAt: 5 },
      ],
    } satisfies AskResponse);
    const { navigate, input } = renderPalette();
    type(input(), "discount codes");
    fireEvent.keyDown(input(), { key: "Tab" });
    expect(screen.getByText("Ask")).toBeTruthy();
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("group", { name: "Best Matches" })).toBeTruthy());
    expect(groups()).toEqual([["Best Matches", ["Old notesMentions coupons", "Fix login bugAlphaLogin"]]]);
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("/projects/p1/chats/c1"); // sub-agents open their workspace
    paletteOpen.value = true;
  });

  it("offers “Find a chat” for sentence-like queries and leaves Ask mode on Backspace", async () => {
    vi.mocked(askChats).mockResolvedValue({ query: "q", confident: false, model: null, matches: [] });
    const { input } = renderPalette();
    type(input(), "where we added buttons");
    const entry = within(screen.getByRole("group", { name: "Ask" })).getByRole("option");
    expect(entry.textContent).toContain("Find a chat: “where we added buttons”");
    fireEvent.click(entry);
    expect(askChats).toHaveBeenCalledWith("where we added buttons");
    await waitFor(() => expect(screen.getByText("No matching chat found.")).toBeTruthy());
    type(input(), "");
    fireEvent.keyDown(input(), { key: "Backspace" });
    expect(screen.queryByText("Ask")).toBeNull();
  });
});

describe("global shortcuts", () => {
  it("New Chat (⌘N) always starts a standalone chat, even from inside a project (I-214)", () => {
    const navigate = vi.fn();
    const inProject: RouteContext = { workspaceId: "w1", projectId: "p1", isSettings: false, envId: null };
    globalCommands({ navigate, route: inProject, togglePalette: vi.fn() })["new-chat"]();
    expect(navigate).toHaveBeenCalledWith("/");
    globalCommands({ navigate, route: { ...inProject, envId: "e2" }, togglePalette: vi.fn() })["new-chat"]();
    expect(navigate).toHaveBeenLastCalledWith("/e/e2");
  });

  function Harness({ handlers }: { handlers: ShortcutHandlers }) {
    useGlobalShortcuts(handlers);
    return <textarea aria-label="composer" />;
  }

  it("fire from inside the composer; ⌘B is left to rich-text editors", () => {
    const handlers = { "new-chat": vi.fn(), settings: vi.fn(), "toggle-sidebar": vi.fn(), "command-palette": vi.fn() };
    render(<Harness handlers={handlers} />);
    const composer = screen.getByLabelText("composer");
    act(() => {
      fireEvent.keyDown(composer, { key: "k", metaKey: true });
      fireEvent.keyDown(composer, { key: "b", metaKey: true });
      fireEvent.keyDown(composer, { key: "\\", metaKey: true });
    });
    expect(handlers["command-palette"]).toHaveBeenCalledTimes(1);
    expect(handlers["toggle-sidebar"]).toHaveBeenCalledTimes(2);

    const editor = document.createElement("div");
    editor.contentEditable = "true";
    Object.defineProperty(editor, "isContentEditable", { value: true });
    document.body.appendChild(editor);
    fireEvent.keyDown(editor, { key: "b", metaKey: true });
    expect(handlers["toggle-sidebar"]).toHaveBeenCalledTimes(2);
    editor.remove();
  });
});
