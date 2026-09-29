/**
 * I-157: images as files. The blob store (dedupe, atomic writes, GC with a grace period), turning
 * inline images into references, the store writing references, and the migration that moves
 * existing inline images out (rows rewritten, blobs exist, idempotent, a crash mid-way).
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blobHash, type ChatMessage, type ToolResult } from "@glade/protocol";
import { fakePng } from "../src/harness/fake/fake-image.js";
import { BlobStore } from "../src/store/blobs.js";
import { getMeta } from "../src/store/db/database.js";
import { blobRefsIn, externalizeImages, imageSize, resolvePromptImages } from "../src/store/images.js";
import { IMAGES_TO_BLOBS_KEY, migrateInlineImages, vacuumIfAlone } from "../src/store/migrate-images.js";
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
const OTHER_B64 = fakePng(2, 20, 10).toString("base64");

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe("BlobStore", () => {
  it("stores content-addressed files, deduplicated, with no temp files left", () => {
    const blobs = new BlobStore(join(tempDir(), "blobs"));
    const a = blobs.put(PNG, "image/png");
    expect(a.ref).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.path).toBe(join(blobs.dir, a.hash.slice(0, 2), `${a.hash}.png`));
    expect(readFileSync(a.path).equals(PNG)).toBe(true);
    const b = blobs.putBase64(PNG_B64, "image/png");
    expect(b.ref).toBe(a.ref);
    expect(allFiles(blobs.dir)).toEqual([a.path]);
    expect(blobs.find(a.ref)?.mimeType).toBe("image/png");
    expect(blobs.find(a.hash)?.size).toBe(PNG.length);
    expect(blobs.read(a.ref)?.equals(PNG)).toBe(true);
    expect(blobs.find(`sha256:${"0".repeat(64)}`)).toBeNull();
    expect(blobs.find("../../etc/passwd")).toBeNull();
  });

  it("a second put of an old blob refreshes its mtime (a concurrent GC keeps it)", () => {
    const blobs = new BlobStore(join(tempDir(), "blobs"));
    const a = blobs.put(PNG, "image/png");
    const old = new Date(Date.now() - 5 * 3600_000);
    utimesSync(a.path, old, old);
    blobs.put(PNG, "image/png");
    expect(Date.now() - statSync(a.path).mtimeMs).toBeLessThan(60_000);
    expect(blobs.gc(new Set()).deleted).toBe(0);
  });

  it("GC deletes unreferenced blobs only after the grace period, and stale temp files", () => {
    const blobs = new BlobStore(join(tempDir(), "blobs"));
    const kept = blobs.put(PNG, "image/png");
    const young = blobs.putBase64(OTHER_B64, "image/png");
    const old = blobs.put(Buffer.from("old"), "image/jpeg");
    const past = new Date(Date.now() - 2 * 3600_000);
    utimesSync(old.path, past, past);
    const staleTmp = join(blobs.dir, kept.hash.slice(0, 2), `.${kept.hash}.1.abcd.tmp`);
    writeFileSync(staleTmp, "partial");
    utimesSync(staleTmp, past, past);
    utimesSync(kept.path, past, past);
    const result = blobs.gc(new Set([kept.hash]), { graceMs: 3600_000 });
    expect(result).toMatchObject({ scanned: 3, deleted: 1, kept: 1 });
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(kept.path)).toBe(true);
    expect(existsSync(young.path)).toBe(true);
    expect(existsSync(staleTmp)).toBe(false);
    // Past the grace period the young one goes too.
    expect(blobs.gc(new Set([kept.hash]), { graceMs: 0 }).deleted).toBe(1);
  });
});

describe("externalizeImages", () => {
  it("replaces inline images anywhere with references and keeps untouched branches", () => {
    const blobs = new BlobStore(join(tempDir(), "blobs"));
    const text = { type: "text", text: "hi" };
    const value = { a: [text, { type: "image", mimeType: "image/png", data: PNG_B64 }], b: { nested: { type: "image", mimeType: "image/png", data: PNG_B64 } }, c: text };
    const count = { n: 0 };
    const out = externalizeImages(value, blobs, count);
    expect(count.n).toBe(2);
    expect(out.a[0]).toBe(text);
    expect(out.c).toBe(text);
    const ref = (out.a[1] as unknown as { blob: string }).blob;
    expect(out.a[1]).toEqual({ type: "image", mimeType: "image/png", blob: ref, width: 40, height: 30 });
    expect(out.b.nested).toEqual(out.a[1]);
    expect(blobs.read(ref)?.equals(PNG)).toBe(true);
    // Nothing inline: the same object back.
    expect(externalizeImages(out, blobs)).toBe(out);
    expect([...blobRefsIn(JSON.stringify(out))]).toEqual([blobHash(ref)]);
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
    const { ref } = blobs.put(PNG, "image/png");
    const inline = { mimeType: "image/png", data: OTHER_B64 };
    const out = resolvePromptImages([inline, { mimeType: "image/png", data: "", blob: ref }], blobs)!;
    expect(out[0]).toBe(inline);
    expect(out[1]).toEqual({ mimeType: "image/png", data: PNG_B64 });
    expect(() => resolvePromptImages([{ mimeType: "image/png", data: "", blob: `sha256:${"1".repeat(64)}` }], blobs)).toThrow(/no longer available/);
  });
});

function userMessage(id: string, data: string): ChatMessage {
  return { id, role: "user", content: [{ type: "image", mimeType: "image/png", data }, { type: "text", text: `msg ${id}` }], timestamp: 1_000 + id.length };
}

function toolResult(id: string, data: string): ToolResult {
  return { toolCallId: id, toolName: "screenshot", status: "done", output: "shot", images: [{ type: "image", mimeType: "image/png", data }] };
}

/** Write rows with inline images the way a pre-I-157 server did (bypassing the store's conversion). */
function writeLegacyRows(store: Store, sessionId: string, n: number): void {
  const db = store.db;
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const m = userMessage(`m${i}`, i % 2 ? OTHER_B64 : PNG_B64);
    db.prepare(
      "INSERT INTO messages (id, session_id, seq, role, created_at, updated_at, status, payload_version, payload_json) VALUES (?, ?, ?, 'user', ?, ?, 'done', 1, ?)",
    ).run(m.id, sessionId, i, now, now, JSON.stringify(m));
    const r = toolResult(`t${i}`, PNG_B64);
    db.prepare("INSERT INTO tool_results (session_id, tool_call_id, status, updated_at, payload_json) VALUES (?, ?, 'done', ?, ?)").run(sessionId, r.toolCallId, now, JSON.stringify(r));
  }
  db.prepare("INSERT INTO events (at, server_id, scope, session_id, type, entity_id, payload_json) VALUES (?, 'old', 'session', ?, 'session_event', ?, ?)").run(
    now,
    sessionId,
    sessionId,
    JSON.stringify({ event: { type: "message_end", message: userMessage("m0", PNG_B64) } }),
  );
  db.prepare("INSERT INTO transcripts (session_id, source, version, message_count, updated_at) VALUES (?, 'live', 1, ?, ?)").run(sessionId, n, now);
}

function inlineRows(store: Store): number {
  let n = 0;
  for (const table of ["messages", "tool_results", "events"]) {
    n += Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE payload_json LIKE '%"data":"%'`).get() as { n: number }).n);
  }
  return n;
}

describe("the store writes references (I-157)", () => {
  it("live changes and imports store blob refs, and reads come back with refs", () => {
    const store = openStore(tempDir());
    store.saveTranscriptChanges("s1", [{ message: userMessage("u1", PNG_B64), seq: 0 }], [toolResult("t1", PNG_B64)]);
    const imported = store.importTranscript("s2", { messages: [userMessage("u2", OTHER_B64)], toolResults: {} }, { source: "pi", sig: null });
    expect(inlineRows(store)).toBe(0);
    const t = store.loadTranscript("s1");
    const img = (t.messages[0] as Extract<ChatMessage, { role: "user" }>).content[0]!;
    expect(img).toMatchObject({ type: "image", mimeType: "image/png", blob: expect.stringMatching(/^sha256:/) });
    expect(t.toolResults.t1!.images![0]!.blob).toBe((img as { blob: string }).blob);
    // The merged transcript handed back to the caller has refs too.
    expect(JSON.stringify(imported.transcript)).not.toContain('"data":"');
    expect(store.referencedBlobs().size).toBe(2);
  });

  it("collects the blobs of a deleted chat (after the grace period)", () => {
    const store = openStore(tempDir());
    store.upsertWorkspace({ id: "w1", projectId: null, title: "W", titleSource: "user", cwd: "/tmp", pinned: false, createdAt: 0, lastActivityAt: 0, layout: null } as never);
    store.upsertSession({ id: "s1", workspaceId: "w1", kind: "main", harness: "fake", sessionRef: null, title: "x", titleSource: "user", createdAt: 0, lastActivityAt: 0 } as never);
    store.saveTranscriptChanges("s1", [{ message: userMessage("u1", PNG_B64), seq: 0 }], []);
    const [hash] = [...store.referencedBlobs()];
    const file = store.blobs.find(hash!)!.path;
    expect(store.collectBlobs({ graceMs: 0 }).deleted).toBe(0);
    store.removeSession("s1");
    expect(store.collectBlobs().deleted).toBe(0); // still inside the grace period
    expect(store.collectBlobs({ graceMs: 0 }).deleted).toBe(1);
    expect(existsSync(file)).toBe(false);
  });
});

describe("migration: inline images to blobs (I-157)", () => {
  it("rewrites rows to refs, writes the blobs, and is idempotent", () => {
    const dir = tempDir();
    const first = openStore(dir, { migrateImages: false });
    writeLegacyRows(first, "s1", 5);
    const before = inlineRows(first);
    expect(before).toBe(11);
    const result = migrateInlineImages(first.db, first.blobs, { batchSize: 2 });
    expect(result).toMatchObject({ ran: true, images: 11, skipped: 0, rows: { messages: 5, tool_results: 5, events: 1 } });
    expect(inlineRows(first)).toBe(0);
    expect(getMeta(first.db, IMAGES_TO_BLOBS_KEY)).toBe("done");
    // Two distinct images, both on disk; every ref resolves.
    expect(allFiles(first.blobs.dir)).toHaveLength(2);
    for (const hash of first.referencedBlobs()) expect(first.blobs.read(hash)).not.toBeNull();
    const t = first.loadTranscript("s1");
    expect(t.messages).toHaveLength(5);
    expect((t.messages[1] as Extract<ChatMessage, { role: "user" }>).content[1]).toEqual({ type: "text", text: "msg m1" });
    // Again: nothing to do (flag), and even when forced nothing changes.
    expect(migrateInlineImages(first.db, first.blobs).ran).toBe(false);
    expect(migrateInlineImages(first.db, first.blobs, { force: true })).toMatchObject({ ran: true, images: 0 });
  });

  it("runs when a store opens and survives a crash mid-way (the next run finishes)", () => {
    const dir = tempDir();
    const store = openStore(dir, { migrateImages: false });
    writeLegacyRows(store, "s1", 4);
    let seen = 0;
    expect(() =>
      migrateInlineImages(store.db, store.blobs, {
        batchSize: 1,
        afterBlobs: () => {
          if (++seen === 3) throw new Error("crash");
        },
      }),
    ).toThrow("crash");
    // The first two batches are done; the rest is still inline and readable; no flag yet.
    expect(inlineRows(store)).toBe(9 - 2); // 4 messages + 4 tool results + 1 event, minus the 2 rewritten
    expect(getMeta(store.db, IMAGES_TO_BLOBS_KEY)).toBeNull();
    store.dispose();
    // The next start finishes the job.
    const reopened = openStore(dir);
    expect(reopened.imageMigration?.ran).toBe(true);
    expect(inlineRows(reopened)).toBe(0);
    expect(getMeta(reopened.db, IMAGES_TO_BLOBS_KEY)).toBe("done");
    expect(reopened.loadTranscript("s1").messages).toHaveLength(4);
  });

  it("leaves a row another server changed meanwhile for the next pass", () => {
    const dir = tempDir();
    const store = openStore(dir, { migrateImages: false });
    writeLegacyRows(store, "s1", 1);
    const result = migrateInlineImages(store.db, store.blobs, {
      afterBlobs: (table) => {
        if (table === "tool_results") store.db.prepare("UPDATE tool_results SET payload_json = replace(payload_json, 'shot', 'shot2')").run();
      },
    });
    expect(result.skipped).toBe(1);
    expect(getMeta(store.db, IMAGES_TO_BLOBS_KEY)).toBeNull();
    expect(migrateInlineImages(store.db, store.blobs).skipped).toBe(0);
    expect(inlineRows(store)).toBe(0);
  });

  it("VACUUMs once afterwards, only when no other server uses the folder", () => {
    const store = openStore(tempDir(), { migrateImages: false });
    writeLegacyRows(store, "s1", 2);
    migrateInlineImages(store.db, store.blobs);
    expect(vacuumIfAlone(store.db, () => false)).toBe(false);
    expect(getMeta(store.db, "vacuum_pending")).toBe("1");
    expect(vacuumIfAlone(store.db, () => true)).toBe(true);
    expect(getMeta(store.db, "vacuum_pending")).toBe("0");
    expect(vacuumIfAlone(store.db, () => true)).toBe(false);
  });
});
