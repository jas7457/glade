/**
 * I-203: the chat header's bookmarks button and list: count, rows (label, time, first line),
 * ↑/↓ + ↩ jumps (opening the right tab), Reference puts a chip in the shown tab's composer, Copy,
 * ⌫ removes, rename in place (empty = automatic).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/preact";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    deleteBookmark: vi.fn(async () => undefined),
    updateBookmark: vi.fn(async (id: string, body: { label: string | null }) => ({ ...bookmarks.value.find((b) => b.id === id)!, label: body.label ?? "Auto", labelSource: body.label ? "user" : "auto" })),
    getBookmarkContent: vi.fn(async () => ({ text: "server text" })),
  },
}));
vi.mock("@/features/workspace/layout-actions", () => ({ focusMainTab: vi.fn(), openSubagent: vi.fn() }));

import type { Bookmark } from "@glade/protocol";
import { api } from "@glade/app-core/lib/api";
import { TooltipProvider } from "@glade/app-core/ui";
import { bookmarkListOpen } from "@glade/app-core/state/bookmarks";
import { bookmarks, sessions, workspaces } from "@glade/app-core/state/store";
import { getChatSession, resetChatSessions } from "@glade/app-core/state/chat-session";
import { pendingJump } from "@glade/app-core/features/chat/jump-to-message";
import { composerReferences, referencesOf } from "@glade/app-core/features/chat/references";
import { composerPrefill } from "@glade/app-core/features/chat/composer-prefill";
import { makeSession, makeWorkspace } from "@glade/app-core/test/fixtures";
import { focusMainTab, openSubagent } from "@/features/workspace/layout-actions";
import { BookmarksButton } from "./BookmarksButton";

const now = Date.now();
const bm = (over: Partial<Bookmark> & { id: string }): Bookmark => ({
  sessionId: "s1",
  workspaceId: "w1",
  message: { role: "assistant", timestamp: now - 1000 },
  label: over.id,
  labelSource: "auto",
  excerpt: `${over.id} first line`,
  createdAt: 1,
  ...over,
});

const writeText = vi.fn(async () => undefined);
Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

function setup() {
  const navigate = vi.fn();
  render(
    <TooltipProvider>
      <BookmarksButton workspace={workspaces.value[0]!} sessionId="s1" navigate={navigate} />
    </TooltipProvider>,
  );
  return navigate;
}

const rows = () => within(screen.getByRole("listbox", { name: "Bookmarks" })).getAllByRole("option");

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
  bookmarkListOpen.value = null;
  pendingJump.value = null;
  composerReferences.value = new Map();
  workspaces.value = [makeWorkspace({ id: "w1", title: "Chat" })];
  sessions.value = [makeSession({ id: "s1", workspaceId: "w1", kind: "main" }), makeSession({ id: "sub", workspaceId: "w1", kind: "subagent", parentSessionId: "s1" })];
  bookmarks.value = [
    bm({ id: "Older", message: { role: "user", timestamp: now - 5000 } }),
    bm({ id: "Newer", message: { role: "assistant", timestamp: now - 1000 } }),
    bm({ id: "Agent", sessionId: "sub", message: { role: "assistant", timestamp: now - 3000 } }),
    bm({ id: "Elsewhere", workspaceId: "w2", sessionId: "x" }),
  ];
});

describe("BookmarksButton (I-203)", () => {
  it("shows the chat's count and lists its bookmarks, latest message first", async () => {
    setup();
    const button = screen.getByRole("button", { name: "3 bookmarks" });
    fireEvent.click(button);
    expect(bookmarkListOpen.value).toBe("w1");
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(rows().map((r) => r.textContent?.split(/\d/)[0])).toEqual(["Newer", "Agent", "Older"]);
    expect(rows()[0]!.textContent).toContain("Newer first line");
  });

  it("↓ + ↩ opens the tab and jumps to the message; a sub-agent's opens its pane", async () => {
    bookmarkListOpen.value = "w1";
    const navigate = setup();
    const list = await screen.findByRole("listbox", { name: "Bookmarks" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(pendingJump.value).toMatchObject({ sessionId: "sub", message: { role: "assistant", timestamp: now - 3000 } });
    expect(focusMainTab).toHaveBeenCalledWith("w1", "s1", navigate);
    expect(openSubagent).toHaveBeenCalledWith("w1", "s1", "sub");
    expect(bookmarkListOpen.value).toBeNull();
  });

  it("Reference adds a chip to the shown tab's composer (with the message's text) and focuses it", async () => {
    getChatSession("s1").transcript.value = {
      messages: [{ id: "a", role: "assistant", content: [{ type: "text", text: "## Loaded\n\nreply" }], timestamp: now - 1000 }],
      toolResults: {},
    };
    bookmarkListOpen.value = "w1";
    setup();
    await screen.findByRole("listbox", { name: "Bookmarks" });
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Reference in Message" }));
    await waitFor(() => expect(referencesOf("chat:s1")).toHaveLength(1));
    expect(referencesOf("chat:s1")[0]).toMatchObject({ id: "Newer", label: "Newer", text: "## Loaded\n\nreply" });
    expect(composerPrefill.value).toMatchObject({ draftKey: "chat:s1", text: "" });
  });

  it("copies (⌘C, from the server when not loaded), removes with ⌫ and renames in place", async () => {
    bookmarkListOpen.value = "w1";
    setup();
    const list = await screen.findByRole("listbox", { name: "Bookmarks" });
    fireEvent.keyDown(list, { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("server text"));
    expect(api.getBookmarkContent).toHaveBeenCalledWith("Newer");

    fireEvent.keyDown(list, { key: "Backspace" });
    await waitFor(() => expect(api.deleteBookmark).toHaveBeenCalledWith("Newer"));
    expect(rows()).toHaveLength(2);

    fireEvent.contextMenu(rows()[0]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename…" }));
    const field = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.input(field, { target: { value: "My agent notes" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(api.updateBookmark).toHaveBeenCalledWith("Agent", { label: "My agent notes" }));
    await waitFor(() => expect(rows()[0]!.textContent).toContain("My agent notes"));
  });

  it("says how to add one when the chat has none", async () => {
    bookmarks.value = [];
    bookmarkListOpen.value = "w1";
    setup();
    expect(screen.getByRole("button", { name: "Bookmarks" })).toBeTruthy();
    expect(await screen.findByText("No bookmarks in this chat")).toBeTruthy();
  });
});
