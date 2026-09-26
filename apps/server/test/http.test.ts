import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ChatDetail, PickFolderResponse, Project, ServerMessage } from "@pi-ui/protocol";
import { createApp } from "../src/http/app.js";
import { createFolderPicker, type CreateFolderPickerOptions, type OsascriptRunner } from "../src/services/folder-picker.js";
import { hostHeaderHostname, isLoopbackOrigin } from "../src/http/security.js";
import { createTestEnv, flush, until, type TestEnv } from "./helpers.js";

let env: TestEnv;
let app: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  env = createTestEnv();
  app = createApp({ service: env.service }).app;
});
afterEach(async () => {
  await env.cleanup();
});

const HOST = { host: "127.0.0.1:4317" };

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: { ...HOST, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("REST API", () => {
  it("creates and lists projects and chats", async () => {
    const path = join(env.dir, "proj");
    mkdirSync(path);
    const res = await req("POST", "/api/projects", { path });
    expect(res.status).toBe(200);
    const project = (await res.json()) as Project;
    expect(project.path).toBe(path);
    expect(await (await req("GET", "/api/projects")).json()).toEqual([project]);

    const created = await req("POST", "/api/chats", { projectId: project.id, prompt: "hi" });
    expect(created.status).toBe(200);
    const detail = (await created.json()) as ChatDetail;
    expect(detail.chat.projectId).toBe(project.id);
    await flush();

    const chats = (await (await req("GET", "/api/chats")).json()) as unknown[];
    expect(chats).toHaveLength(1);
    const again = (await (await req("GET", `/api/chats/${detail.chat.id}`)).json()) as ChatDetail;
    expect(again.transcript.messages.length).toBe(3);

    expect((await req("PATCH", `/api/chats/${detail.chat.id}`, { pinned: true })).status).toBe(200);
    expect((await req("POST", `/api/chats/${detail.chat.id}/prompt`, { text: "more" })).status).toBe(204);
    expect((await req("POST", `/api/chats/${detail.chat.id}/abort`)).status).toBe(204);
    expect((await req("PUT", `/api/chats/${detail.chat.id}/model`, { provider: "fake", id: "fast" })).status).toBe(204);
    expect((await req("PUT", `/api/chats/${detail.chat.id}/thinking`, { level: "off" })).status).toBe(204);
    expect((await req("DELETE", `/api/chats/${detail.chat.id}`)).status).toBe(204);
    expect((await req("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
  });

  it("returns 404 for unknown chats and routes", async () => {
    const res = await req("GET", "/api/chats/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Chat not found" });
    expect((await req("GET", "/api/nothing")).status).toBe(404);
    expect((await req("PATCH", "/api/projects/nope", { name: "x" })).status).toBe(404);
  });

  it("returns 400 for invalid bodies", async () => {
    expect((await req("POST", "/api/projects", "{not json")).status).toBe(400);
    expect((await req("POST", "/api/projects", {})).status).toBe(400);
    const missing = await req("POST", "/api/projects", { path: join(env.dir, "missing") });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toMatch(/Not a folder/);
    expect((await req("POST", "/api/chats", { projectId: 5 })).status).toBe(400);
    const chat = (await (await req("POST", "/api/chats", { projectId: null })).json()) as ChatDetail;
    expect((await req("PUT", `/api/chats/${chat.chat.id}/thinking`, { level: "huge" })).status).toBe(400);
    expect((await req("PUT", `/api/chats/${chat.chat.id}/model`, { provider: "fake" })).status).toBe(400);
    expect((await req("POST", `/api/chats/${chat.chat.id}/prompt`, { text: 1 })).status).toBe(400);
    expect((await req("POST", `/api/chats/${chat.chat.id}/prompt`, { text: " " })).status).toBe(400);
  });

  it("serves models and settings", async () => {
    const models = (await (await req("GET", "/api/models?refresh=1")).json()) as unknown[];
    expect(models.length).toBeGreaterThan(0);
    const patched = await req("PATCH", "/api/settings", { general: { sendKey: "mod-enter" } });
    expect(((await patched.json()) as { general: { sendKey: string } }).general.sendKey).toBe("mod-enter");
    expect(((await (await req("GET", "/api/settings")).json()) as { general: { sendKey: string } }).general.sendKey).toBe(
      "mod-enter",
    );
  });
});

describe("POST /api/fs/pick-folder", () => {
  const withPicker = (options: CreateFolderPickerOptions) =>
    createApp({ service: env.service, pickFolder: createFolderPicker(options) }).app;
  const pick = (a: typeof app, body?: unknown) =>
    a.request("/api/fs/pick-folder", {
      method: "POST",
      headers: { ...HOST, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("returns the chosen folder without a trailing slash", async () => {
    const run = vi.fn<OsascriptRunner>().mockResolvedValue("/Users/me/code/app/\n");
    const res = await pick(withPicker({ platform: "darwin", run }));
    expect(res.status).toBe(200);
    expect((await res.json()) as PickFolderResponse).toEqual({ path: "/Users/me/code/app" });
    const [args] = run.mock.calls[0]!;
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain("choose folder with prompt");
    expect(args[1]).toContain("activateIgnoringOtherApps");
  });

  it("passes prompt and default location, quoted for AppleScript", async () => {
    const run = vi.fn<OsascriptRunner>().mockResolvedValue("/\n");
    const res = await pick(withPicker({ platform: "darwin", run }), { prompt: 'Pick "it"', defaultPath: "/tmp/a b" });
    expect(await res.json()).toEqual({ path: "/" });
    const script = run.mock.calls[0]![0][1]!;
    expect(script).toContain('choose folder with prompt "Pick \\"it\\"" default location (POSIX file "/tmp/a b")');
  });

  it("reports cancel (-128) as cancelled", async () => {
    const err = Object.assign(new Error("Command failed"), { stderr: "execution error: User canceled. (-128)" });
    const res = await pick(withPicker({ platform: "darwin", run: vi.fn<OsascriptRunner>().mockRejectedValue(err) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
  });

  it("returns 500 for other osascript failures", async () => {
    const err = Object.assign(new Error("Command failed"), { stderr: "execution error: boom (-1)" });
    const res = await pick(withPicker({ platform: "darwin", run: vi.fn<OsascriptRunner>().mockRejectedValue(err) }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/boom/);
  });

  it("returns 501 off macOS without running anything", async () => {
    const run = vi.fn<OsascriptRunner>();
    const res = await pick(withPicker({ platform: "linux", run }));
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toMatch(/macOS/);
    expect(run).not.toHaveBeenCalled();
  });

  it("validates the body", async () => {
    const run = vi.fn<OsascriptRunner>();
    expect((await pick(withPicker({ platform: "darwin", run }), { prompt: 5 })).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("requires a loopback Origin (it's a mutating request)", async () => {
    const run = vi.fn<OsascriptRunner>();
    const a = withPicker({ platform: "darwin", run });
    const res = await a.request("/api/fs/pick-folder", { method: "POST", headers: { ...HOST, origin: "https://evil.com" } });
    expect(res.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("security", () => {
  it("rejects non-loopback Host headers", async () => {
    for (const host of ["evil.com", "evil.com:4317", "127.0.0.1.evil.com", "user@localhost"]) {
      const res = await req("GET", "/api/chats", undefined, { host });
      expect(res.status, host).toBe(403);
    }
    for (const host of ["localhost:4317", "127.0.0.1", "[::1]:4317", "LOCALHOST"]) {
      expect((await req("GET", "/api/chats", undefined, { host })).status, host).toBe(200);
    }
  });

  it("rejects mutating requests from non-loopback origins", async () => {
    const path = join(env.dir, "p");
    mkdirSync(path);
    expect((await req("POST", "/api/projects", { path }, { origin: "https://evil.com" })).status).toBe(403);
    expect((await req("POST", "/api/projects", { path }, { origin: "null" })).status).toBe(403);
    expect((await req("POST", "/api/projects", { path }, { origin: "http://localhost:5317" })).status).toBe(200);
    // No Origin (e.g. curl) is fine; GETs don't check Origin.
    expect((await req("POST", "/api/projects", { path })).status).toBe(200);
    expect((await req("GET", "/api/projects", undefined, { origin: "https://evil.com" })).status).toBe(200);
  });

  it("parses hosts and origins", () => {
    expect(hostHeaderHostname("[::1]:4317")).toBe("[::1]");
    expect(hostHeaderHostname("a b")).toBeNull();
    expect(isLoopbackOrigin("http://127.0.0.1:5317")).toBe(true);
    expect(isLoopbackOrigin("tauri://localhost")).toBe(true);
    expect(isLoopbackOrigin("http://localhost.evil.com")).toBe(false);
  });
});

describe("WebSocket /ws", () => {
  it("says hello, pushes broadcasts and tracks the viewed chat", async () => {
    const { app: wsApp, injectWebSocket } = createApp({ service: env.service });
    const server = serve({ fetch: wsApp.fetch, hostname: "127.0.0.1", port: 0 });
    injectWebSocket(server);
    await new Promise<void>((r) => server.once("listening", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const received: ServerMessage[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://localhost:5317" });
      ws.on("message", (data) => received.push(JSON.parse(String(data)) as ServerMessage));
      await new Promise((r, j) => ws.once("open", r).once("error", j));
      await until(() => received.length > 0);
      expect(received[0]).toEqual({ type: "hello", version: expect.any(String) });

      const detail = await env.service.createChat({ projectId: null });
      await until(() => received.some((m) => m.type === "chat_upsert"));

      ws.send(JSON.stringify({ type: "viewing", chatId: detail.chat.id }));
      await flush(20);
      await env.service.prompt(detail.chat.id, { text: "hi" });
      await until(() => received.some((m) => m.type === "chat_event" && m.event.type === "run_end"));
      expect(env.store.getChat(detail.chat.id)?.unread).toBe(false);

      // Closing the socket stops viewing: the next run marks the chat unread.
      ws.close();
      await flush(50);
      await env.service.prompt(detail.chat.id, { text: "again" });
      await flush(10);
      expect(env.store.getChat(detail.chat.id)?.unread).toBe(true);

      // Upgrades from foreign origins are refused.
      const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "https://evil.com" });
      const status = await new Promise<number>((resolve) => {
        evil.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        evil.once("error", () => resolve(-1));
      });
      expect(status).toBe(403);
    } finally {
      server.close();
    }
  });
});
