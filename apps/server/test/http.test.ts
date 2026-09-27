import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type {
  CreateWorkspaceResponse,
  PickFolderResponse,
  Project,
  ServerMessage,
  SessionDetail,
  SessionSummary,
  WorkspaceDetail,
  WorkspaceSummary,
} from "@glade/protocol";
import { createApp } from "../src/http/app.js";
import { createFolderPicker, type CreateFolderPickerOptions, type OsascriptRunner } from "../src/services/folder-picker.js";
import { hostHeaderHostname, isLoopbackOrigin } from "../src/http/security.js";
import { createTestEnv, flush, newChat, until, type TestEnv } from "./helpers.js";

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
  it("creates and lists projects, workspaces and sessions", async () => {
    const path = join(env.dir, "proj");
    mkdirSync(path);
    const res = await req("POST", "/api/projects", { path });
    expect(res.status).toBe(200);
    const project = (await res.json()) as Project;
    expect(project.path).toBe(path);
    expect(await (await req("GET", "/api/projects")).json()).toEqual([project]);

    const created = await req("POST", "/api/workspaces", { projectId: project.id, prompt: "hi" });
    expect(created.status).toBe(200);
    const detail = (await created.json()) as CreateWorkspaceResponse;
    expect(detail.workspace.projectId).toBe(project.id);
    expect(detail.sessions.map((s) => s.id)).toEqual([detail.session.session.id]);
    const wid = detail.workspace.id;
    const sid = detail.session.session.id;
    await flush();

    const workspaces = (await (await req("GET", "/api/workspaces")).json()) as WorkspaceSummary[];
    expect(workspaces.map((w) => w.id)).toEqual([wid]);
    // Legacy alias used by the desktop app's quit check.
    expect(((await (await req("GET", "/api/chats")).json()) as WorkspaceSummary[])[0]).toMatchObject({ id: wid, status: "unread" });
    const again = (await (await req("GET", `/api/sessions/${sid}`)).json()) as SessionDetail;
    expect(again.transcript.messages.length).toBe(3);
    const ws = (await (await req("GET", `/api/workspaces/${wid}`)).json()) as WorkspaceDetail;
    expect(ws.sessions.map((s) => s.id)).toEqual([sid]);
    expect(((await (await req("GET", `/api/workspaces/${wid}/sessions`)).json()) as SessionSummary[]).map((s) => s.id)).toEqual([sid]);
    expect(((await (await req("GET", "/api/sessions")).json()) as SessionSummary[]).map((s) => s.id)).toEqual([sid]);

    expect((await req("PATCH", `/api/workspaces/${wid}`, { pinned: true })).status).toBe(200);
    expect((await req("PATCH", `/api/workspaces/${wid}`, { layout: { activeMainSessionId: sid } })).status).toBe(200);
    expect((await req("PATCH", `/api/workspaces/${wid}`, { layout: "wide" })).status).toBe(400);
    expect((await req("PATCH", `/api/sessions/${sid}`, { unread: false })).status).toBe(200);
    expect((await req("POST", `/api/sessions/${sid}/prompt`, { text: "more" })).status).toBe(204);
    expect((await req("POST", `/api/sessions/${sid}/abort`)).status).toBe(204);
    expect((await req("PUT", `/api/sessions/${sid}/model`, { provider: "fake", id: "fast" })).status).toBe(204);
    expect((await req("PUT", `/api/sessions/${sid}/thinking`, { level: "off" })).status).toBe(204);

    // A second tab; then the first can be closed, but not the last one.
    const tab = await req("POST", `/api/workspaces/${wid}/sessions`, {});
    expect(tab.status).toBe(200);
    const tabId = ((await tab.json()) as SessionDetail).session.id;
    expect((await req("POST", `/api/workspaces/${wid}/sessions`)).status).toBe(200); // body optional
    expect((await req("POST", `/api/workspaces/${wid}/sessions`, { thinkingLevel: "huge" })).status).toBe(400);
    expect((await req("DELETE", `/api/sessions/${sid}`)).status).toBe(204);
    expect((await req("DELETE", `/api/sessions/${tabId}`)).status).toBe(204);
    const last = await req("DELETE", `/api/sessions/${env.service.listSessions(wid)[0]!.id}`);
    expect(last.status).toBe(409);

    expect((await req("DELETE", `/api/workspaces/${wid}`)).status).toBe(204);
    expect((await req("DELETE", `/api/projects/${project.id}`)).status).toBe(204);
  });

  it("returns 404 for unknown workspaces, sessions and routes", async () => {
    const res = await req("GET", "/api/sessions/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
    expect(await (await req("GET", "/api/workspaces/nope")).json()).toEqual({ error: "Workspace not found" });
    expect((await req("POST", "/api/workspaces/nope/sessions", {})).status).toBe(404);
    expect((await req("POST", "/api/sessions/nope/prompt", { text: "x" })).status).toBe(404);
    expect((await req("POST", "/api/sessions/nope/abort")).status).toBe(404);
    expect((await req("GET", "/api/nothing")).status).toBe(404);
    expect((await req("GET", "/api/chats/nope")).status).toBe(404); // old per-chat routes are gone
    expect((await req("PATCH", "/api/projects/nope", { name: "x" })).status).toBe(404);
  });

  it("returns 400 for invalid bodies", async () => {
    expect((await req("POST", "/api/projects", "{not json")).status).toBe(400);
    expect((await req("POST", "/api/projects", {})).status).toBe(400);
    const missing = await req("POST", "/api/projects", { path: join(env.dir, "missing") });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toMatch(/Not a folder/);
    expect((await req("POST", "/api/workspaces", { projectId: 5 })).status).toBe(400);
    const created = (await (await req("POST", "/api/workspaces", { projectId: null })).json()) as CreateWorkspaceResponse;
    const sid = created.session.session.id;
    expect((await req("PUT", `/api/sessions/${sid}/thinking`, { level: "huge" })).status).toBe(400);
    expect((await req("PUT", `/api/sessions/${sid}/model`, { provider: "fake" })).status).toBe(400);
    expect((await req("POST", `/api/sessions/${sid}/prompt`, { text: 1 })).status).toBe(400);
    expect((await req("POST", `/api/sessions/${sid}/prompt`, { text: " " })).status).toBe(400);
    expect((await req("PATCH", `/api/sessions/${sid}`, { interrupted: true })).status).toBe(400);
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
  it("says hello, pushes broadcasts and tracks the viewed sessions", async () => {
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

      const a = await newChat(env);
      const b = await newChat(env);
      await until(() => received.some((m) => m.type === "session_upsert") && received.some((m) => m.type === "workspace_upsert"));

      // Several sessions can be on screen at once.
      ws.send(JSON.stringify({ type: "viewing", sessionIds: [a.sid, b.sid] }));
      await flush(20);
      await env.service.prompt(a.sid, { text: "hi" });
      await env.service.prompt(b.sid, { text: "hi" });
      await until(() => received.filter((m) => m.type === "session_event" && m.event.type === "run_end").length === 2);
      expect(received).toContainEqual(expect.objectContaining({ type: "session_event", sessionId: a.sid, workspaceId: a.wid }));
      expect(env.store.getSession(a.sid)?.unread).toBe(false);
      expect(env.store.getSession(b.sid)?.unread).toBe(false);

      // Replacing the list stops viewing b.
      ws.send(JSON.stringify({ type: "viewing", sessionIds: [a.sid] }));
      await flush(20);
      await env.service.prompt(b.sid, { text: "again" });
      await flush(10);
      expect(env.store.getSession(b.sid)?.unread).toBe(true);

      // Closing the socket stops viewing: the next run marks the session unread.
      ws.close();
      await flush(50);
      await env.service.prompt(a.sid, { text: "again" });
      await flush(10);
      expect(env.store.getSession(a.sid)?.unread).toBe(true);

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
