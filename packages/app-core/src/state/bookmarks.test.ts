/**
 * I-203: bookmarks on the client against a mocked API: the latest reply (⌘D), toggling, renaming,
 * removing, the text for Copy / Reference (loaded transcript, then the server, then the excerpt),
 * and the shell pushes (upsert, remove, removed with their chat, snapshot, check).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookmark, ChatMessage } from "@glade/protocol";

vi.mock("@glade/app-core/lib/api", () => ({
  api: {
    createBookmark: vi.fn(),
    updateBookmark: vi.fn(),
    deleteBookmark: vi.fn(),
    getBookmarkContent: vi.fn(),
  },
}));

import { api } from "@glade/app-core/lib/api";
import { applyShellCheck, applyShellSnapshot, handleServerMessage, resetShellSync } from "./store";
import {
  bookmarkText,
  bookmarks,
  bookmarksOfWorkspace,
  latestReply,
  messageBookmark,
  renameBookmark,
  removeBookmark,
  toggleBookmark,
  toggleLatestReplyBookmark,
} from "./bookmarks";
import { getChatSession, resetChatSessions } from "./chat-session";
import { toasts } from "./toasts";
import { defaultSettings } from "@glade/protocol";

const mocked = vi.mocked(api);

const bm = (over: Partial<Bookmark> & { id: string }): Bookmark => ({
  sessionId: "s1",
  workspaceId: "w1",
  message: { role: "assistant", timestamp: 2 },
  label: over.id,
  labelSource: "auto",
  excerpt: `excerpt ${over.id}`,
  createdAt: 1,
  ...over,
});

const user = (id: string, timestamp: number, text: string): ChatMessage => ({ id, role: "user", content: [{ type: "text", text }], timestamp });
const reply = (id: string, timestamp: number, text: string): ChatMessage => ({ id, role: "assistant", content: [{ type: "text", text }], timestamp });

beforeEach(() => {
  vi.clearAllMocks();
  resetChatSessions();
  resetShellSync();
  toasts.value = [];
  bookmarks.value = [];
});

describe("latestReply (⌘D)", () => {
  it("is the last agent turn, anchored by its first message, with all its text", () => {
    const messages: ChatMessage[] = [
      user("u1", 1, "q"),
      reply("a1", 2, "first"),
      user("u2", 3, "more?"),
      reply("a2", 4, "part one"),
      { id: "side", role: "side", question: "?", answer: "!", status: "done", timestamp: 5 },
      reply("a3", 6, "part two"),
    ];
    expect(latestReply(messages)).toEqual({ anchor: { role: "assistant", timestamp: 4 }, text: "part one\n\npart two" });
    // Just sent a new message: the reply before it.
    expect(latestReply([...messages, user("u3", 7, "next")])?.anchor).toEqual({ role: "assistant", timestamp: 4 });
    expect(latestReply([user("u1", 1, "q")])).toBeNull();
  });

  it("toggles the bookmark on the latest reply of a loaded chat", async () => {
    getChatSession("s1").transcript.value = { messages: [user("u1", 1, "q"), reply("a1", 2, "## Answer")], toolResults: {} };
    mocked.createBookmark.mockResolvedValue(bm({ id: "b1" }));
    expect(await toggleLatestReplyBookmark("s1")).toBe("added");
    expect(mocked.createBookmark).toHaveBeenCalledWith({ sessionId: "s1", message: { role: "assistant", timestamp: 2 }, text: "## Answer" });
    expect(messageBookmark("s1", { role: "assistant", timestamp: 2 })?.id).toBe("b1");
    mocked.deleteBookmark.mockResolvedValue(undefined);
    expect(await toggleLatestReplyBookmark("s1")).toBe("removed");
    expect(bookmarks.value).toEqual([]);
    expect(toasts.value.map((t) => t.message)).toEqual(["Bookmarked the latest reply", "Removed the bookmark"]);
  });
});

describe("bookmark actions", () => {
  it("toggling a bookmarked message removes it; a failed removal puts it back", async () => {
    bookmarks.value = [bm({ id: "b1" })];
    mocked.deleteBookmark.mockRejectedValueOnce(new Error("offline"));
    expect(await removeBookmark("b1")).toBe(false);
    expect(bookmarks.value.map((b) => b.id)).toEqual(["b1"]);
    mocked.deleteBookmark.mockResolvedValueOnce(undefined);
    expect(await toggleBookmark("s1", { role: "assistant", timestamp: 2 }, "x")).toBe("removed");
    expect(bookmarks.value).toEqual([]);
  });

  it("renames, and resets to the automatic label", async () => {
    bookmarks.value = [bm({ id: "b1" })];
    mocked.updateBookmark.mockResolvedValueOnce(bm({ id: "b1", label: "Mine", labelSource: "user" }));
    expect(await renameBookmark("b1", " Mine ")).toBe(true);
    expect(mocked.updateBookmark).toHaveBeenCalledWith("b1", { label: "Mine" });
    expect(bookmarks.value[0]).toMatchObject({ label: "Mine", labelSource: "user" });
    mocked.updateBookmark.mockResolvedValueOnce(bm({ id: "b1", label: "Auto" }));
    await renameBookmark("b1", "");
    expect(mocked.updateBookmark).toHaveBeenLastCalledWith("b1", { label: null });
    expect(bookmarks.value[0]?.label).toBe("Auto");
  });

  it("lists a chat's bookmarks latest message first", () => {
    bookmarks.value = [bm({ id: "a", message: { role: "user", timestamp: 1 } }), bm({ id: "b", message: { role: "assistant", timestamp: 9 } }), bm({ id: "c", workspaceId: "w2" })];
    expect(bookmarksOfWorkspace("w1").map((b) => b.id)).toEqual(["b", "a"]);
  });

  it("text for Copy / Reference: the loaded transcript, else the server, else the excerpt", async () => {
    getChatSession("s1").transcript.value = { messages: [user("u1", 1, "q\n\nAttached file: /x.png"), reply("a1", 2, "loaded answer")], toolResults: {} };
    expect(await bookmarkText(bm({ id: "b1" }))).toBe("loaded answer");
    expect(await bookmarkText(bm({ id: "b2", message: { role: "user", timestamp: 1 } }))).toBe("q");
    expect(await bookmarkText(bm({ id: "b3", selection: "just this" }))).toBe("just this");
    expect(mocked.getBookmarkContent).not.toHaveBeenCalled();

    mocked.getBookmarkContent.mockResolvedValueOnce({ text: "from the server" });
    expect(await bookmarkText(bm({ id: "b4", message: { role: "assistant", timestamp: 99 } }))).toBe("from the server");
    mocked.getBookmarkContent.mockResolvedValueOnce({ text: null });
    expect(await bookmarkText(bm({ id: "b5", message: { role: "assistant", timestamp: 99 } }))).toBe("excerpt b5");
  });
});

describe("bookmarks in the shell sync", () => {
  it("applies pushes; a deleted chat or tab takes its bookmarks along", () => {
    handleServerMessage({ type: "bookmark_upsert", bookmark: bm({ id: "b1" }) });
    handleServerMessage({ type: "bookmark_upsert", bookmark: bm({ id: "b2", sessionId: "s2" }) });
    handleServerMessage({ type: "bookmark_upsert", bookmark: bm({ id: "b3", workspaceId: "w9", sessionId: "s9" }) });
    handleServerMessage({ type: "bookmark_upsert", bookmark: bm({ id: "b1", label: "renamed" }) });
    expect(bookmarks.value.map((b) => b.label)).toEqual(["renamed", "b2", "b3"]);
    handleServerMessage({ type: "session_removed", sessionId: "s2", workspaceId: "w1" });
    expect(bookmarks.value.map((b) => b.id)).toEqual(["b1", "b3"]);
    handleServerMessage({ type: "workspace_removed", workspaceId: "w1" });
    expect(bookmarks.value.map((b) => b.id)).toEqual(["b3"]);
    handleServerMessage({ type: "bookmark_removed", bookmarkId: "b3" });
    expect(bookmarks.value).toEqual([]);
  });

  it("takes them from a snapshot and drops what the check doesn't list", () => {
    applyShellSnapshot({ projects: [], workspaces: [], sessions: [], settings: defaultSettings(), bookmarks: [bm({ id: "b1" }), bm({ id: "b2" })] });
    expect(bookmarks.value.map((b) => b.id)).toEqual(["b1", "b2"]);
    expect(applyShellCheck({ projects: [], workspaces: [], sessions: [], bookmarks: ["b2"] })).toBe(false);
    expect(bookmarks.value.map((b) => b.id)).toEqual(["b2"]);
    // The server has one we don't: resubscribe.
    expect(applyShellCheck({ projects: [], workspaces: [], sessions: [], bookmarks: ["b2", "b3"] })).toBe(true);
  });
});
