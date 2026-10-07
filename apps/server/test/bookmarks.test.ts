/**
 * I-203: bookmarks. Store (persisted, migration 8, anchor resolution, another server's changes,
 * removed with their chat), the REST routes (create / list / rename / remove / content) and sync
 * (snapshot, check, pushes, replay).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Bookmark, BookmarkContent, ChatMessage, ServerMessage, Transcript } from "@glade/protocol";
import { createApp } from "../src/http/app.js";
import { openDatabase, schemaVersion } from "../src/store/db/database.js";
import { MIGRATIONS } from "../src/store/db/migrations/index.js";
import type { SyncSocket } from "../src/services/sync/hub.js";
import { Store, type StoreChange } from "../src/store/store.js";
import { createTestEnv, newChat, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeEach(() => {
  env = createTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const { app } = createApp({ service: env.service });
  const res = await app.request(path, {
    method,
    headers: { host: "127.0.0.1:4317", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const user = (id: string, timestamp: number, text: string): ChatMessage => ({ id, role: "user", content: [{ type: "text", text }], timestamp });
const reply = (id: string, timestamp: number, text: string | null): ChatMessage => ({
  id,
  role: "assistant",
  content: text === null ? [{ type: "toolCall", id: `c-${id}`, name: "bash", kind: "shell", input: { command: "ls" }, args: { command: "ls" } }] : [{ type: "text", text }],
  timestamp,
  stopReason: text === null ? "toolUse" : "stop",
});

const conversation: Transcript = {
  messages: [
    user("u1", 1000, "what are the Q3 numbers?\n\nAttached file: /tmp/q3.csv"),
    reply("a1", 1001, "Let me look."),
    reply("a2", 1002, null),
    reply("a3", 1003, "## Q3\n\n| a | 1 |"),
    { id: "n1", role: "notice", kind: "compaction", text: "Compacted context", timestamp: 1004 },
    user("u2", 1005, "thanks"),
    reply("a4", 1006, "Welcome."),
  ],
  toolResults: {},
};

describe("bookmarks in the store (I-203)", () => {
  it("migration 8 adds the table; bookmarks survive a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "glade-bookmarks-"));
    try {
      const db = openDatabase(join(dir, "x.db"), MIGRATIONS.slice(0, 7));
      expect(schemaVersion(db)).toBe(7);
      db.close();
      const upgraded = openDatabase(join(dir, "x.db"));
      expect(schemaVersion(upgraded)).toBeGreaterThanOrEqual(8);
      expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bookmarks'").get()).toBeTruthy();
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves anchors from the stored rows: a user message, an agent reply's whole turn, missing ones", () => {
    env.store.importTranscript("s-old", conversation, { source: "test", sig: null });
    expect(env.store.anchoredMessageText("s-old", { role: "user", timestamp: 1000 })).toBe("what are the Q3 numbers?");
    expect(env.store.anchoredMessageText("s-old", { role: "assistant", timestamp: 1001 })).toBe("Let me look.\n\n## Q3\n\n| a | 1 |");
    // The compaction notice ends the turn; the later reply is found on its own.
    expect(env.store.anchoredMessageText("s-old", { role: "assistant", timestamp: 1006 })).toBe("Welcome.");
    expect(env.store.anchoredMessageText("s-old", { role: "assistant", timestamp: 999 })).toBeNull();
    expect(env.store.anchoredMessageText("other", { role: "user", timestamp: 1000 })).toBeNull();
  });

  it("another server's bookmark changes are reported (StoreChange.bookmarks)", async () => {
    const { sid, wid } = await newChat(env);
    const other = new Store(env.store.dataDir, 0, { serverId: "other" });
    try {
      const changes: StoreChange[] = [];
      env.store.onExternalChange((c) => changes.push(c));
      const bookmark: Bookmark = { id: "b1", sessionId: sid, workspaceId: wid, message: { role: "user", timestamp: 1 }, label: "x", labelSource: "auto", excerpt: "x", createdAt: 1 };
      other.upsertBookmark(bookmark);
      env.store.reload();
      expect(changes.at(-1)?.bookmarks?.upserted).toEqual([bookmark]);
      expect(env.store.getBookmark("b1")).toEqual(bookmark);
      other.removeBookmarks(["b1"]);
      env.store.reload();
      expect(changes.at(-1)?.bookmarks?.removed).toEqual(["b1"]);
      expect(env.store.getBookmark("b1")).toBeUndefined();
    } finally {
      other.dispose();
    }
  });

  it("drops bookmarks whose chat is gone when it opens (deleted by an older server)", () => {
    env.store.upsertBookmark({ id: "orphan", sessionId: "gone", workspaceId: "gone", message: { role: "user", timestamp: 1 }, label: "x", labelSource: "auto", excerpt: "", createdAt: 1 });
    const reopened = new Store(env.store.dataDir, 0);
    try {
      expect(reopened.getBookmark("orphan")).toBeUndefined();
    } finally {
      reopened.dispose();
    }
  });
});

describe("bookmarks API (I-203)", () => {
  it("creates (label + excerpt from the text), dedupes, lists, renames, resets and removes", async () => {
    const { sid, wid } = await newChat(env);
    const created = await req<Bookmark>("POST", "/api/bookmarks", { sessionId: sid, message: { role: "assistant", timestamp: 5 }, text: "Intro\n\n## The numbers\n\n- **a**: 1" });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ sessionId: sid, workspaceId: wid, label: "The numbers", labelSource: "auto", excerpt: "Intro The numbers a: 1", environmentId: env.store.environmentId });
    expect(env.messages).toContainEqual({ type: "bookmark_upsert", bookmark: created.body });

    // Same message again: the same bookmark.
    const again = await req<Bookmark>("POST", "/api/bookmarks", { sessionId: sid, message: { role: "assistant", timestamp: 5 }, text: "other" });
    expect(again.body.id).toBe(created.body.id);
    // A selection of it is a bookmark of its own.
    const passage = await req<Bookmark>("POST", "/api/bookmarks", { sessionId: sid, message: { role: "assistant", timestamp: 5 }, text: "x", selection: "  a: 1  " });
    expect(passage.body).toMatchObject({ selection: "a: 1", label: "a: 1" });
    expect(passage.body.id).not.toBe(created.body.id);

    expect((await req<Bookmark[]>("GET", "/api/bookmarks")).body.map((b) => b.id)).toEqual([passage.body.id, created.body.id]);
    expect((await req<Bookmark[]>("GET", `/api/bookmarks?workspaceId=${wid}`)).body).toHaveLength(2);
    expect((await req<Bookmark[]>("GET", "/api/bookmarks?workspaceId=nope")).body).toEqual([]);

    const renamed = await req<Bookmark>("PATCH", `/api/bookmarks/${created.body.id}`, { label: "  Q3 data " });
    expect(renamed.body).toMatchObject({ label: "Q3 data", labelSource: "user" });
    // Back to automatic: the message isn't stored (fake id), so the excerpt names it.
    const reset = await req<Bookmark>("PATCH", `/api/bookmarks/${created.body.id}`, { label: null });
    expect(reset.body).toMatchObject({ labelSource: "auto", label: "Intro The numbers a: 1" });

    expect((await req("DELETE", `/api/bookmarks/${passage.body.id}`)).status).toBe(204);
    expect(env.messages).toContainEqual({ type: "bookmark_removed", bookmarkId: passage.body.id });
    expect((await req("DELETE", `/api/bookmarks/${passage.body.id}`)).status).toBe(404);
    expect(env.store.listBookmarks().map((b) => b.id)).toEqual([created.body.id]);
  });

  it("validates requests", async () => {
    const { sid } = await newChat(env);
    expect((await req("POST", "/api/bookmarks", { sessionId: "nope", message: { role: "user", timestamp: 1 }, text: "" })).status).toBe(404);
    expect((await req("POST", "/api/bookmarks", { sessionId: sid, message: { role: "shell", timestamp: 1 }, text: "" })).status).toBe(400);
    expect((await req("POST", "/api/bookmarks", { sessionId: sid, message: { role: "user" }, text: "" })).status).toBe(400);
    expect((await req("POST", "/api/bookmarks", { message: { role: "user", timestamp: 1 } })).status).toBe(400);
    expect((await req("PATCH", "/api/bookmarks/nope", { label: "x" })).status).toBe(404);
    expect((await req("GET", "/api/bookmarks/nope/content")).status).toBe(404);
  });

  it("content: the message's text now (live chat), the selection, or null when it's gone", async () => {
    const { sid } = await newChat(env, { prompt: "hello there" });
    await new Promise((r) => setTimeout(r, 50));
    const detail = await env.service.getSessionDetail(sid);
    const first = detail.transcript.messages.find((m) => m.role === "user")!;
    const b = env.service.createBookmark({ sessionId: sid, message: { role: "user", timestamp: first.timestamp }, text: "hello there" });
    expect((await req<BookmarkContent>("GET", `/api/bookmarks/${b.id}/content`)).body).toEqual({ text: "hello there" });
    const replyMsg = detail.transcript.messages.find((m) => m.role === "assistant")!;
    const r = env.service.createBookmark({ sessionId: sid, message: { role: "assistant", timestamp: replyMsg.timestamp }, text: "" });
    expect((await req<BookmarkContent>("GET", `/api/bookmarks/${r.id}/content`)).body.text).toEqual(expect.stringContaining("hello there"));
    const gone = env.service.createBookmark({ sessionId: sid, message: { role: "assistant", timestamp: 1 }, text: "old" });
    expect((await req<BookmarkContent>("GET", `/api/bookmarks/${gone.id}/content`)).body).toEqual({ text: null });
    const sel = env.service.createBookmark({ sessionId: sid, message: { role: "assistant", timestamp: 1 }, text: "", selection: "just this" });
    expect((await req<BookmarkContent>("GET", `/api/bookmarks/${sel.id}/content`)).body).toEqual({ text: "just this" });
  });

  it("goes with its chat: closing a tab or deleting the workspace removes its bookmarks", async () => {
    const { sid, wid } = await newChat(env);
    const tab = await env.service.createSession(wid, {});
    const keep = await newChat(env);
    const onTab = env.service.createBookmark({ sessionId: tab.session.id, message: { role: "user", timestamp: 1 }, text: "tab" });
    const onMain = env.service.createBookmark({ sessionId: sid, message: { role: "user", timestamp: 1 }, text: "main" });
    const other = env.service.createBookmark({ sessionId: keep.sid, message: { role: "user", timestamp: 1 }, text: "other" });
    await env.service.deleteSession(tab.session.id);
    expect(env.store.getBookmark(onTab.id)).toBeUndefined();
    expect(env.store.getBookmark(onMain.id)).toBeDefined();
    await env.service.deleteWorkspace(wid);
    expect(env.store.listBookmarks().map((b) => b.id)).toEqual([other.id]);
    // Nothing left in the table either.
    const reopened = new Store(env.store.dataDir, 0);
    try {
      expect(reopened.listBookmarks().map((b) => b.id)).toEqual([other.id]);
    } finally {
      reopened.dispose();
    }
  });
});

class TestSocket implements SyncSocket {
  readonly sent: ServerMessage[] = [];
  send(data: string): void {
    const m = JSON.parse(data) as ServerMessage;
    this.sent.push(...(m.type === "batch" ? m.messages : [m]));
  }
  bufferedAmount(): number {
    return 0;
  }
  close(): void {}
}

describe("bookmarks over sync (I-203)", () => {
  it("snapshot and live check include bookmarks; changes (and chat deletes) are pushed and replayed", async () => {
    const { sid, wid } = await newChat(env);
    const early = env.service.createBookmark({ sessionId: sid, message: { role: "user", timestamp: 1 }, text: "early" });
    const socket = new TestSocket();
    const client = env.service.sync.connect(socket);
    client.subscribeShell();
    env.service.sync.tick();
    const snapshot = socket.sent.find((m) => m.type === "snapshot" && m.scope === "shell");
    expect(snapshot?.type === "snapshot" && snapshot.scope === "shell" && snapshot.shell.bookmarks?.map((b) => b.id)).toEqual([early.id]);
    const live = socket.sent.find((m) => m.type === "live" && m.scope === "shell");
    expect(live?.type === "live" && live.scope === "shell" && live.check.bookmarks).toEqual([early.id]);
    const after = env.store.headSeq;
    socket.sent.length = 0;

    const late = env.service.createBookmark({ sessionId: sid, message: { role: "user", timestamp: 2 }, text: "late" });
    env.service.updateBookmark(early.id, { label: "Renamed" });
    env.service.sync.tick();
    const pushed = socket.sent.filter((m) => m.type === "bookmark_upsert" || m.type === "bookmark_removed");
    expect(pushed.map((m) => m.type === "bookmark_upsert" && m.bookmark.label)).toEqual(["late", "Renamed"]);
    expect(pushed.every((m) => typeof m.seq === "number" && typeof m.prev === "number")).toBe(true);
    socket.sent.length = 0;

    // Deleting the chat removes its bookmarks on every client.
    await env.service.deleteWorkspace(wid);
    env.service.sync.tick();
    const removed = socket.sent.filter((m) => m.type === "bookmark_removed").map((m) => m.type === "bookmark_removed" && m.bookmarkId);
    expect(removed.sort()).toEqual([early.id, late.id].sort());

    // A client back from before the changes gets them replayed.
    const again = new TestSocket();
    env.service.sync.connect(again).subscribeShell(after);
    env.service.sync.tick();
    const replayed = again.sent.filter((m) => m.type === "bookmark_removed").map((m) => m.type === "bookmark_removed" && m.bookmarkId);
    expect(replayed.sort()).toEqual([early.id, late.id].sort());
  });
});
