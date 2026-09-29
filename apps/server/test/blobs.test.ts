/**
 * I-157/I-163: images as files, one folder per chat. The blob store (per-chat atomic writes,
 * stable names, path safety, legacy hash files), turning images into references to a chat's
 * files (inline → written, foreign refs → copied), the store writing references and deleting a
 * chat's folder with it, and the migration of inline images and legacy `sha256:` refs into
 * per-chat folders (shared file copied per chat, crash mid-way, idempotent, old files removed).
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseBlobRef, type ChatMessage, type Session, type ToolResult, type Workspace } from "@glade/protocol";
import { fakePng } from "../src/harness/fake/fake-image.js";
import { BlobStore } from "../src/store/blobs.js";
import { getMeta } from "../src/store/db/database.js";
import { externalizeImages, imageSize, resolvePromptImages } from "../src/store/images.js";
import { IMAGES_PER_CHAT_KEY, migrateImagesPerChat, moveAttachmentsIntoChats, vacuumIfAlone } from "../src/store/migrate-images.js";
import { Store } from "../src/store/store.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "glade-blobs-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function openStore(dir: string, opts: { migrateImages?: boolean } = {}): Store {
  const store = new Store(join(dir, "data"), 0, opts);
  cleanups.push(() => store.dispose());
  return store;
}

const PNG = fakePng(1, 40, 30);
const PNG_B64 = PNG.toString("base64");
const OTHER = fakePng(2, 20, 10);
const OTHER_B64 = OTHER.toString("base64");

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/** A file the way I-157 stored it: `<aa>/<sha256>.png`; returns its `sha256:` ref. */
function legacyBlob(blobsDir: string, bytes: Buffer): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(join(blobsDir, hash.slice(0, 2)), { recursive: true });
  writeFileSync(join(blobsDir, hash.slice(0, 2), `${hash}.png`), bytes);
  return `sha256:${hash}`;
}

function addChat(store: Store, id: string, workspaceId = "w1"): void {
  if (!store.getWorkspace(workspaceId)) {
    store.upsertWorkspace({ id: workspaceId, projectId: null, title: "W", titleSource: "user", cwd: "/tmp", pinned: false, createdAt: 0, lastActivityAt: 0, layout: null } as unknown as Workspace);
  }
  store.upsertSession({ id, workspaceId, kind: "main", harness: "fake", sessionRef: null, title: id, titleSource: "user", createdAt: 0, lastActivityAt: 0 } as unknown as Session);
}

describe("BlobStore (per chat)", () => {
  it("writes into the chat's folder atomically, with a stable name per content", () => {
    const blobs = new BlobStore(join(tempDir(), "blobs"));
    const a = blobs.put("chat-1", PNG, "image/png");
    expect(a.ref).toMatch(/^chat-1\/[0-9a-f]{16}$/);
    expect(a.path).toBe(join(blobs.dir, "chat-1", "images", `${a.ref.split("/")[1]}.png`));
    expect(readFileSync(a.path).equals(PNG)).toBe(true);
    // Saving it again in the same chat finds the file.
    expect(blobs.putBase64("chat-1", PNG_B64, "image/png").ref).toBe(a.ref);
    expect(allFiles(blobs.dir)).toEqual([a.path]);
    // The same picture in another chat is another file (no sharing).
    const b = blobs.put("chat-2", PNG, "image/png");
    expect(b.ref).not.toBe(a.ref);
    expect(allFiles(blobs.dir)).toHaveLength(2);
    expect(blobs.find(a.ref)?.mimeType).toBe("image/png");
    expect(blobs.read(b.ref)?.equals(PNG)).toBe(true);
  });

  it("rejects anything that could leave the folder", () => {
    const blobs = new BlobStore(join(tempDir(), "blobs"));
    for (const ref of ["../glade.db", "chat-1/../../x", "../x", "./x", "chat-1/.hidden", "a/b/c", "chat-1/", "/etc/passwd"]) {
      expect(parseBlobRef(ref)).toBeNull();
      expect(blobs.find(ref)).toBeNull();
    }
    expect(() => blobs.put("..", PNG, "image/png")).toThrow();
    expect(() => blobs.put("a/b", PNG, "image/png")).toThrow();
  });

  it("removeChat deletes the chat's folder only", () => {
    const blobs = new BlobStore(join(tempDir(), "blobs"));
    const a = blobs.put("chat-1", PNG, "image/png");
    const b = blobs.put("chat-2", PNG, "image/png");
    blobs.removeChat("chat-1");
    expect(existsSync(join(blobs.dir, "chat-1"))).toBe(false);
    expect(blobs.find(a.ref)).toBeNull();
    expect(blobs.find(b.ref)).not.toBeNull();
    blobs.removeChat(".."); // ignored
    expect(existsSync(blobs.dir)).toBe(true);
  });

  it("still reads legacy sha256 files, and removes the unreferenced ones", () => {
    const blobs = new BlobStore(join(tempDir(), "blobs"));
    const kept = legacyBlob(blobs.legacyDir, PNG);
    const gone = legacyBlob(blobs.legacyDir, OTHER);
    blobs.put("chat-1", PNG, "image/png");
    expect(blobs.read(kept)?.equals(PNG)).toBe(true);
    expect(blobs.find(kept.slice(7))?.mimeType).toBe("image/png");
    expect(blobs.hasLegacy()).toBe(true);
    expect(blobs.removeLegacy(new Set([kept.slice(7)])).deleted).toBe(1);
    expect(blobs.find(gone)).toBeNull();
    expect(blobs.removeLegacy(new Set()).deleted).toBe(1);
    expect(blobs.hasLegacy()).toBe(false); // emptied folders go too
    expect(allFiles(blobs.dir)).toHaveLength(1); // the chat's file is untouched
  });
});

describe("externalizeImages", () => {
  it("writes inline images to the chat's folder and keeps untouched branches", () => {
    const blobs = new BlobStore(join(tempDir(), "blobs"));
    const text = { type: "text", text: "hi" };
    const value = { a: [text, { type: "image", mimeType: "image/png", data: PNG_B64 }], b: { nested: { type: "image", mimeType: "image/png", data: PNG_B64 } }, c: text };
    const count = { n: 0 };
    const out = externalizeImages(value, blobs, "s1", count);
    expect(count.n).toBe(2);
    expect(out.a[0]).toBe(text);
    expect(out.c).toBe(text);
    const ref = (out.a[1] as unknown as { blob: string }).blob;
    expect(ref.startsWith("s1/")).toBe(true);
    expect(out.a[1]).toEqual({ type: "image", mimeType: "image/png", blob: ref, width: 40, height: 30 });
    expect(out.b.nested).toEqual(out.a[1]);
    expect(blobs.read(ref)?.equals(PNG)).toBe(true);
    // Own refs only: the same object back.
    expect(externalizeImages(out, blobs, "s1")).toBe(out);
  });

  it("copies another chat's or a legacy file into this chat; a missing one is left as it is", () => {
    const blobs = new BlobStore(join(tempDir(), "blobs"));
    const foreign = blobs.put("s1", PNG, "image/png").ref;
    const legacy = legacyBlob(blobs.legacyDir, OTHER);
    const value = [
      { type: "image", mimeType: "image/png", blob: foreign },
      { type: "image", mimeType: "image/png", blob: legacy },
      { type: "image", mimeType: "image/png", blob: "s9/deadbeef" },
    ];
    const count = { n: 0, missing: 0 };
    const out = externalizeImages(value, blobs, "s2", count);
    expect(count).toEqual({ n: 2, missing: 1 });
    expect(out[0]!.blob.startsWith("s2/")).toBe(true);
    expect(out[1]!.blob.startsWith("s2/")).toBe(true);
    expect(out[2]).toBe(value[2]);
    expect(blobs.read(out[0]!.blob)?.equals(PNG)).toBe(true);
    expect(blobs.read(out[1]!.blob)?.equals(OTHER)).toBe(true);
    expect(blobs.find(foreign)).not.toBeNull(); // a copy, not a move
  });

  it("reads image sizes of PNG, GIF and JPEG headers", () => {
    expect(imageSize(fakePng(0, 7, 5))).toEqual({ width: 7, height: 5 });
    expect(imageSize(Buffer.from("GIF89a\x0a\x00\x14\x00", "latin1"))).toEqual({ width: 10, height: 20 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x30, 0x00, 0x40, 0x03]);
    expect(imageSize(jpeg)).toEqual({ width: 64, height: 48 });
    expect(imageSize(Buffer.from("nope"))).toBeNull();
  });

  it("resolves prompt images sent by reference back to data (what the harness is fed)", () => {
    const blobs = new BlobStore(join(tempDir(), "blobs"));
    const { ref } = blobs.put("s1", PNG, "image/png");
    const legacy = legacyBlob(blobs.legacyDir, OTHER);
    const inline = { mimeType: "image/png", data: OTHER_B64 };
    const out = resolvePromptImages([inline, { mimeType: "image/png", data: "", blob: ref }, { mimeType: "image/png", data: "", blob: legacy }], blobs)!;
    expect(out[0]).toBe(inline);
    expect(out[1]).toEqual({ mimeType: "image/png", data: PNG_B64 });
    expect(out[2]).toEqual({ mimeType: "image/png", data: OTHER_B64 });
    expect(() => resolvePromptImages([{ mimeType: "image/png", data: "", blob: "s1/0000000000000000" }], blobs)).toThrow(/no longer available/);
  });
});

function userMessage(id: string, image: Record<string, unknown>): ChatMessage {
  return { id, role: "user", content: [{ type: "image", mimeType: "image/png", ...image }, { type: "text", text: `msg ${id}` }], timestamp: 1_000 + id.length } as ChatMessage;
}

function toolResult(id: string, image: Record<string, unknown>): ToolResult {
  return { toolCallId: id, toolName: "screenshot", status: "done", output: "shot", images: [{ type: "image", mimeType: "image/png", ...image }] } as ToolResult;
}

describe("the store writes per-chat references (I-163)", () => {
  it("live changes and imports go to their chat's folder; the same image in two chats is two files", () => {
    const store = openStore(tempDir());
    store.saveTranscriptChanges("s1", [{ message: userMessage("u1", { data: PNG_B64 }), seq: 0 }], [toolResult("t1", { data: PNG_B64 })]);
    const imported = store.importTranscript("s2", { messages: [userMessage("u2", { data: PNG_B64 })], toolResults: {} }, { source: "pi", sig: null });
    const t = store.loadTranscript("s1");
    const img = (t.messages[0] as Extract<ChatMessage, { role: "user" }>).content[0] as { blob: string };
    expect(img).toMatchObject({ type: "image", mimeType: "image/png", blob: expect.stringMatching(/^s1\//) });
    expect(t.toolResults.t1!.images![0]!.blob).toBe(img.blob);
    expect(JSON.stringify(imported.transcript)).toMatch(/"blob":"s2\//);
    expect(JSON.stringify(imported.transcript)).not.toContain('"data":"');
    expect(allFiles(store.blobs.dir).map((f) => f.slice(store.blobs.dir.length + 1).split("/")[0])).toEqual(["s1", "s2"]);
    // Importing the same transcript again writes nothing new.
    store.importTranscript("s2", { messages: [userMessage("u2", { data: PNG_B64 })], toolResults: {} }, { source: "pi", sig: null });
    expect(allFiles(store.blobs.dir)).toHaveLength(2);
  });

  it("deleting a chat, or a workspace's chats, deletes their folders right away", () => {
    const store = openStore(tempDir());
    for (const id of ["s1", "s2"]) addChat(store, id);
    addChat(store, "s3", "w2");
    for (const id of ["s1", "s2", "s3"]) store.saveTranscriptChanges(id, [{ message: userMessage(`u-${id}`, { data: PNG_B64 }), seq: 0 }], []);
    const folder = (id: string) => join(store.blobs.dir, id);
    expect(["s1", "s2", "s3"].every((id) => existsSync(folder(id)))).toBe(true);
    store.removeSession("s1");
    expect(existsSync(folder("s1"))).toBe(false);
    expect(existsSync(folder("s2"))).toBe(true);
    store.removeWorkspace("w1");
    expect(existsSync(folder("s2"))).toBe(false);
    expect(existsSync(folder("s3"))).toBe(true);
  });

  it("deleting a chat deletes its sync log rows too, but keeps the event that says it's gone", () => {
    const store = openStore(tempDir());
    for (const id of ["s1", "s2"]) addChat(store, id);
    for (const id of ["s1", "s2"]) store.saveTranscriptChanges(id, [{ message: userMessage(`u-${id}`, { data: PNG_B64 }), seq: 0 }], []);
    const count = (where: string, ...args: string[]) => Number((store.db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ${where}`).get(...args) as { n: number }).n);
    expect(count("session_id = ?", "s1")).toBeGreaterThan(0);
    store.removeSession("s1");
    expect(count("session_id = ?", "s1")).toBe(0);
    expect(count("type = 'session' AND entity_id = ?", "s1")).toBeGreaterThan(0);
    expect(count("session_id = ?", "s2")).toBeGreaterThan(0);
    for (const table of ["messages", "tool_results", "transcripts", "session_summaries", "sessions"]) {
      const col = table === "sessions" ? "id" : "session_id";
      expect(Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = 's1'`).get() as { n: number }).n), table).toBe(0);
    }
    store.removeWorkspace("w1");
    expect(count("session_id = ?", "s2")).toBe(0);
  });
});

/** Rows as I-157 left them: `sha256:` refs (and a few inline images from before I-157). */
function writeLegacyRows(store: Store, sessionId: string, n: number, refs: { png: string; other: string }): void {
  const db = store.db;
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const m = userMessage(`${sessionId}-m${i}`, i === 0 ? { data: PNG_B64 } : { blob: i % 2 ? refs.other : refs.png });
    db.prepare(
      "INSERT INTO messages (id, session_id, seq, role, created_at, updated_at, status, payload_version, payload_json) VALUES (?, ?, ?, 'user', ?, ?, 'done', 1, ?)",
    ).run(m.id, sessionId, i, now, now, JSON.stringify(m));
    const r = toolResult(`t${i}`, { blob: refs.png });
    db.prepare("INSERT INTO tool_results (session_id, tool_call_id, status, updated_at, payload_json) VALUES (?, ?, 'done', ?, ?)").run(sessionId, r.toolCallId, now, JSON.stringify(r));
  }
  db.prepare("INSERT INTO events (at, server_id, scope, session_id, type, entity_id, payload_json) VALUES (?, 'old', 'session', ?, 'session_event', ?, ?)").run(
    now,
    sessionId,
    sessionId,
    JSON.stringify({ event: { type: "message_end", message: userMessage("x", { blob: refs.png }) } }),
  );
  db.prepare("INSERT INTO transcripts (session_id, source, version, message_count, updated_at) VALUES (?, 'live', 1, ?, ?)").run(sessionId, n, now);
}

function oldRows(store: Store): number {
  let n = 0;
  for (const table of ["messages", "tool_results", "events"]) {
    n += Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE payload_json LIKE '%"data":"%' OR payload_json LIKE '%"blob":"sha256:%'`).get() as { n: number }).n);
  }
  return n;
}

function refsIn(store: Store, sessionId: string): string[] {
  const rows = store.db.prepare("SELECT payload_json AS j FROM messages WHERE session_id = ? UNION ALL SELECT payload_json FROM tool_results WHERE session_id = ?").all(sessionId, sessionId) as Array<{ j: string }>;
  return rows.flatMap((r) => [...r.j.matchAll(/"blob":"([^"]+)"/g)].map((m) => m[1]!));
}

function legacySetup(dir: string, chats: string[], n: number): { store: Store; refs: { png: string; other: string } } {
  const store = openStore(dir, { migrateImages: false });
  const refs = { png: legacyBlob(store.blobs.legacyDir, PNG), other: legacyBlob(store.blobs.legacyDir, OTHER) };
  for (const id of chats) {
    addChat(store, id);
    writeLegacyRows(store, id, n, refs);
  }
  return { store, refs };
}

describe("migration: images into per-chat folders (I-163)", () => {
  it("copies a shared file into each chat, rewrites the refs, removes the old files, and is idempotent", () => {
    const { store } = legacySetup(tempDir(), ["s1", "s2"], 4);
    expect(oldRows(store)).toBe(2 * (4 + 4 + 1));
    const result = migrateImagesPerChat(store.db, store.blobs, { batchSize: 2 });
    expect(result).toMatchObject({ ran: true, skipped: 0, missing: 0, legacyDeleted: 2, rows: { messages: 8, tool_results: 8, events: 2 } });
    expect(oldRows(store)).toBe(0);
    expect(getMeta(store.db, IMAGES_PER_CHAT_KEY)).toBe("done");
    // Each chat has its own copy of both images; the old shared files are gone.
    expect(store.blobs.hasLegacy()).toBe(false);
    const files = allFiles(store.blobs.dir).map((f) => f.slice(store.blobs.dir.length + 1));
    expect(files.filter((f) => f.startsWith("s1/"))).toHaveLength(2);
    expect(files.filter((f) => f.startsWith("s2/"))).toHaveLength(2);
    expect(files).toHaveLength(4);
    for (const id of ["s1", "s2"]) {
      for (const ref of refsIn(store, id)) {
        expect(ref.startsWith(`${id}/`)).toBe(true);
        expect(store.blobs.read(ref)).not.toBeNull();
      }
    }
    const t = store.loadTranscript("s1");
    expect(t.messages).toHaveLength(4);
    expect((t.messages[1] as Extract<ChatMessage, { role: "user" }>).content[1]).toEqual({ type: "text", text: "msg s1-m1" });
    // Deleting one chat leaves the other's images.
    store.removeSession("s1");
    for (const ref of refsIn(store, "s2")) expect(store.blobs.read(ref)).not.toBeNull();
    // Again: nothing to do (flag), and even when forced nothing changes.
    expect(migrateImagesPerChat(store.db, store.blobs).ran).toBe(false);
    expect(migrateImagesPerChat(store.db, store.blobs, { force: true })).toMatchObject({ ran: true, images: 0 });
  });

  it("runs when a store opens and survives a crash mid-way (the next start finishes)", () => {
    const dir = tempDir();
    const { store } = legacySetup(dir, ["s1"], 4);
    let seen = 0;
    expect(() =>
      migrateImagesPerChat(store.db, store.blobs, {
        batchSize: 1,
        afterBlobs: () => {
          if (++seen === 3) throw new Error("crash");
        },
      }),
    ).toThrow("crash");
    // Two rows done; the rest still has old refs that still resolve; no flag; old files kept.
    expect(oldRows(store)).toBe(9 - 2);
    expect(getMeta(store.db, IMAGES_PER_CHAT_KEY)).toBeNull();
    expect(store.blobs.hasLegacy()).toBe(true);
    for (const ref of refsIn(store, "s1")) expect(store.blobs.read(ref)).not.toBeNull();
    store.dispose();
    const reopened = openStore(dir);
    expect(reopened.imageMigration?.ran).toBe(true);
    expect(oldRows(reopened)).toBe(0);
    expect(getMeta(reopened.db, IMAGES_PER_CHAT_KEY)).toBe("done");
    expect(reopened.blobs.hasLegacy()).toBe(false);
    // The copy written before the crash was found again, not duplicated.
    expect(allFiles(reopened.blobs.dir)).toHaveLength(2);
    expect(reopened.loadTranscript("s1").messages).toHaveLength(4);
  });

  it("leaves a row another server changed meanwhile for the next pass (and keeps the old files until then)", () => {
    const { store } = legacySetup(tempDir(), ["s1"], 1);
    const result = migrateImagesPerChat(store.db, store.blobs, {
      afterBlobs: (table) => {
        if (table === "tool_results") store.db.prepare("UPDATE tool_results SET payload_json = replace(payload_json, 'shot', 'shot2')").run();
      },
    });
    expect(result.skipped).toBe(1);
    expect(getMeta(store.db, IMAGES_PER_CHAT_KEY)).toBeNull();
    expect(store.blobs.hasLegacy()).toBe(true);
    expect(migrateImagesPerChat(store.db, store.blobs).skipped).toBe(0);
    expect(oldRows(store)).toBe(0);
    expect(store.blobs.hasLegacy()).toBe(false);
  });

  it("VACUUMs once afterwards, only when no other server uses the folder", () => {
    const store = openStore(tempDir(), { migrateImages: false });
    addChat(store, "s1");
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      store.db
        .prepare("INSERT INTO tool_results (session_id, tool_call_id, status, updated_at, payload_json) VALUES ('s1', ?, 'done', ?, ?)")
        .run(`t${i}`, now, JSON.stringify(toolResult(`t${i}`, { data: randomBytes(400_000).toString("base64") })));
    }
    migrateImagesPerChat(store.db, store.blobs);
    expect(vacuumIfAlone(store.db, () => false)).toBe(false);
    expect(getMeta(store.db, "vacuum_pending")).toBe("1");
    expect(vacuumIfAlone(store.db, () => true)).toBe(true);
    expect(getMeta(store.db, "vacuum_pending")).toBe("0");
    expect(vacuumIfAlone(store.db, () => true)).toBe(false);
  });
});

describe("migration: attached files into the chat folders (I-163)", () => {
  it("moves each chat's attachments into chats/<id>/files, drops deleted chats', and is idempotent", () => {
    const data = join(tempDir(), "data");
    const old = (id: string, name: string, text: string) => {
      mkdirSync(join(data, "attachments", id), { recursive: true });
      writeFileSync(join(data, "attachments", id, name), text);
    };
    old("s1", "a.txt", "a");
    old("s1", "b.txt", "b");
    old("s2", "c.txt", "c");
    old("gone", "d.txt", "d");
    // s2 already has a files folder (a crash mid-way, or an upload since): merged, names kept free.
    mkdirSync(join(data, "chats", "s2", "files"), { recursive: true });
    writeFileSync(join(data, "chats", "s2", "files", "c.txt"), "new");
    const result = moveAttachmentsIntoChats(data, new Set(["s1", "s2"]));
    expect(result).toEqual({ moved: 2, removed: 1 });
    expect(readFileSync(join(data, "chats", "s1", "files", "a.txt"), "utf8")).toBe("a");
    expect(readFileSync(join(data, "chats", "s1", "files", "b.txt"), "utf8")).toBe("b");
    expect(readFileSync(join(data, "chats", "s2", "files", "c.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(data, "chats", "s2", "files", "c (2).txt"), "utf8")).toBe("c");
    expect(existsSync(join(data, "attachments"))).toBe(false);
    expect(existsSync(join(data, "chats", "gone"))).toBe(false);
    expect(moveAttachmentsIntoChats(data, new Set(["s1", "s2"]))).toEqual({ moved: 0, removed: 0 });
  });

  it("runs when a store opens", () => {
    const dir = tempDir();
    const store = openStore(dir, { migrateImages: false });
    addChat(store, "s1");
    store.dispose();
    mkdirSync(join(dir, "data", "attachments", "s1"), { recursive: true });
    writeFileSync(join(dir, "data", "attachments", "s1", "a.txt"), "a");
    const reopened = openStore(dir);
    expect(readFileSync(join(reopened.blobs.dir, "s1", "files", "a.txt"), "utf8")).toBe("a");
    // Deleting the chat deletes its files with its images: one folder.
    reopened.saveTranscriptChanges("s1", [{ message: userMessage("u1", { data: PNG_B64 }), seq: 0 }], []);
    reopened.removeSession("s1");
    expect(existsSync(join(reopened.blobs.dir, "s1"))).toBe(false);
  });
});
