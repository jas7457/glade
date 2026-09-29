import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentUploadResponse } from "@glade/protocol";
import { AttachmentError, AttachmentStore, sanitizeAttachmentName } from "../src/services/attachments.js";
import { createApp } from "../src/http/app.js";
import { createTestEnv, newChat, type TestEnv } from "./helpers.js";

describe("sanitizeAttachmentName", () => {
  it("keeps normal names", () => {
    expect(sanitizeAttachmentName("report.pdf")).toBe("report.pdf");
    expect(sanitizeAttachmentName("My Notes (v2).md")).toBe("My Notes (v2).md");
  });
  it("drops folders, traversal, control and reserved characters", () => {
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentName("..\\..\\win.ini")).toBe("win.ini");
    expect(sanitizeAttachmentName("..")).toBe("file");
    expect(sanitizeAttachmentName(".env")).toBe("env");
    expect(sanitizeAttachmentName("a\nb\u0000c.txt")).toBe("abc.txt");
    expect(sanitizeAttachmentName('we:ird*?"<>|.txt')).toBe("we_ird______.txt");
    expect(sanitizeAttachmentName("   ")).toBe("file");
  });
  it("caps the length but keeps the extension", () => {
    const name = sanitizeAttachmentName(`${"x".repeat(300)}.pdf`);
    expect(name.length).toBeLessThanOrEqual(160);
    expect(name.endsWith(".pdf")).toBe(true);
  });
});

describe("AttachmentStore", () => {
  let dir: string;
  let store: AttachmentStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "glade-att-"));
    store = new AttachmentStore(join(dir, "chats"), join(dir, "attachments"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const bytes = (s: string) => new TextEncoder().encode(s);

  it("saves into the session folder with unique names", async () => {
    const a = await store.save("s1", "notes.txt", bytes("one"));
    const b = await store.save("s1", "notes.txt", bytes("two"));
    const c = await store.save("s1", "../notes.txt", bytes("three"));
    expect(a.path).toBe(join(dir, "chats", "s1", "files", "notes.txt"));
    expect(b.name).toBe("notes (2).txt");
    expect(c.name).toBe("notes (3).txt");
    expect(readFileSync(b.path, "utf8")).toBe("two");
    expect(a.size).toBe(3);
  });

  it("streams bodies and enforces the size cap, leaving nothing behind", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes("12345"));
        controller.enqueue(bytes("67890"));
        controller.close();
      },
    });
    await expect(store.save("s1", "big.bin", stream, { maxBytes: 8 })).rejects.toMatchObject({ status: 413 });
    expect(existsSync(join(dir, "chats", "s1", "files", "big.bin"))).toBe(false);
    const ok = await store.save("s1", "big.bin", bytes("1234"), { maxBytes: 8 });
    expect(ok.size).toBe(4);
  });

  it("refuses session ids that would leave the folder", async () => {
    for (const id of ["..", "../x", "a/b", "", "."]) {
      await expect(store.save(id, "x.txt", bytes("x"))).rejects.toBeInstanceOf(AttachmentError);
    }
    expect(existsSync(join(dir, "x.txt"))).toBe(false);
  });

  it("knows its files and removes a session's folder", async () => {
    const a = await store.save("s1", "a.txt", bytes("a"));
    expect(await store.isAttachment(a.path)).toBe(true);
    expect(await store.isAttachment(join(dir, "chats", "..", "outside.txt"))).toBe(false);
    expect(await store.isAttachment(join(dir, "chats"))).toBe(false);
    expect(await store.isAttachment(join(dir, "chats", "s1", "files"))).toBe(false);
    // Only the files folder: a chat's images aren't attachments.
    mkdirSync(join(dir, "chats", "s1", "images"), { recursive: true });
    writeFileSync(join(dir, "chats", "s1", "images", "x.png"), "x");
    expect(await store.isAttachment(join(dir, "chats", "s1", "images", "x.png"))).toBe(false);
    // An old path (before I-163) maps to where the file is now.
    const old = join(dir, "attachments", "s1", "a.txt");
    expect(store.current(old)).toBe(a.path);
    expect(await store.isAttachment(old)).toBe(true);
    expect(store.current(join(dir, "attachments", "..", "x"))).toBe(join(dir, "attachments", "..", "x"));
    await store.removeSession("s1");
    expect(existsSync(dirname(a.path))).toBe(false);
    await store.removeSession("../..");
    expect(existsSync(dir)).toBe(true);
  });
});

describe("attachments API", () => {
  let env: TestEnv;
  const reveal = vi.fn(async () => {});
  beforeEach(() => {
    env = createTestEnv({ revealPath: reveal });
  });
  afterEach(async () => {
    await env.cleanup();
  });

  const upload = (app: ReturnType<typeof createApp>["app"], sid: string, name: string, body: string) =>
    app.request(`/api/sessions/${sid}/attachments?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { host: "127.0.0.1:4317", "content-type": "application/octet-stream" },
      body,
    });

  it("uploads, reveals and deletes attachments with the session", async () => {
    const { app } = createApp({ service: env.service });
    const { wid, sid } = await newChat(env);
    const res = await upload(app, sid, "report final.pdf", "%PDF");
    expect(res.status).toBe(200);
    const saved = (await res.json()) as AttachmentUploadResponse;
    expect(saved.name).toBe("report final.pdf");
    expect(saved.path).toBe(join(env.store.dataDir, "chats", sid, "files", "report final.pdf"));
    expect(readFileSync(saved.path, "utf8")).toBe("%PDF");

    await env.service.revealPath(saved.path);
    expect(reveal).toHaveBeenCalledWith(saved.path);
    await expect(env.service.revealPath(join(env.store.dataDir, "settings.json"))).rejects.toMatchObject({ status: 404 });

    await env.service.deleteWorkspace(wid);
    expect(existsSync(dirname(saved.path))).toBe(false);
    expect(existsSync(join(env.store.dataDir, "chats", sid))).toBe(false); // the whole chat folder
  });

  it("404s for unknown sessions, 400 without a name, 413 over the cap", async () => {
    const { app } = createApp({ service: env.service });
    const { sid } = await newChat(env);
    expect((await upload(app, "nope", "a.txt", "x")).status).toBe(404);
    expect((await app.request(`/api/sessions/${sid}/attachments`, { method: "POST", headers: { host: "127.0.0.1:4317" }, body: "x" })).status).toBe(400);
    const big = await app.request(`/api/sessions/${sid}/attachments?name=a.bin`, {
      method: "POST",
      headers: { host: "127.0.0.1:4317", "content-length": String(60 * 1024 * 1024) },
      body: "x",
    });
    expect(big.status).toBe(413);
  });

  it("titles a chat from the typed text, not the Attached file lines", async () => {
    const { sid } = await newChat(env);
    await env.service.prompt(sid, { text: "Summarise the report\n\nAttached file: /tmp/x/report.pdf" });
    expect(env.store.getSession(sid)?.title).toBe("Summarise the report");
  });
});
