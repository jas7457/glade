import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/preact";

vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/state/actions", () => ({
  renameWorkspace: vi.fn(async () => true),
  setChatPinned: vi.fn(async () => true),
  deleteChat: vi.fn(async () => true),
  updateSettings: vi.fn(async () => true),
}));

import { renameWorkspace, updateSettings } from "@/state/actions";
import { projects, workspaces } from "@/state/store";
import { paletteOpen, sidebarCollapsed } from "@/state/ui";
import { useGlobalShortcuts, type ShortcutHandlers } from "@/app/shortcuts";
import type { RouteContext } from "@/app/paths";
import { makeWorkspace, makeProject } from "@/test/fixtures";
import { Palette } from "./Palette";

const noRoute: RouteContext = { workspaceId: null, projectId: null, isSettings: false };

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
    const { input } = renderPalette({ workspaceId: "c1", projectId: "p1", isSettings: false });
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

  it("closes on Escape", () => {
    const { input } = renderPalette();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(paletteOpen.value).toBe(false);
  });
});

describe("global shortcuts", () => {
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
