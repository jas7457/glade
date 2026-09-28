/**
 * I-123: this server as an environment. A permanent id kept across restarts, a name (the machine
 * name until renamed) with a sequenced push on rename, `environmentId` on every project (backfilled
 * by migration 3, set at creation, never changed), `hello.environmentId`, and cross-origin access
 * for loopback origins only (CORS + WebSocket; until I-125's device auth).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { COMMAND_ID_HEADER, type EnvironmentInfo, type Project, type ServerMessage } from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { createApp } from "../src/http/app.js";
import { isCorsOrigin } from "../src/http/security.js";
import { AppService } from "../src/services/app-service.js";
import type { EnvironmentOptions } from "../src/services/environment.js";
import type { SyncSocket } from "../src/services/sync/hub.js";
import { openDatabase, schemaVersion } from "../src/store/db/database.js";
import { isUlid } from "../src/store/db/ids.js";
import { MIGRATIONS } from "../src/store/db/migrations/index.js";
import { Store } from "../src/store/store.js";
import { until } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "glade-env-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MACHINE: EnvironmentOptions = { platform: "darwin", hostname: "studio.local", home: "/Users/test", machineName: () => "Test Mac Studio" };

function start(dir = tempDir(), environment: EnvironmentOptions = MACHINE) {
  const store = new Store(join(dir, "data"), 0);
  const service = new AppService({
    store,
    harnesses: new HarnessRegistry([new FakeHarness()]),
    scratchDir: join(dir, "scratch"),
    environment,
    sync: { batchMs: 10_000 },
  });
  const messages: ServerMessage[] = [];
  service.subscribe((m) => messages.push(m));
  const { app, injectWebSocket } = createApp({ service });
  const stop = async () => {
    await service.dispose();
    store.dispose();
  };
  cleanups.push(stop);
  return { dir, store, service, app, injectWebSocket, messages, stop };
}

const HOST = { host: "127.0.0.1:4317" };

function request(app: ReturnType<typeof start>["app"], method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(path, {
    method,
    headers: { ...HOST, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function folder(dir: string, name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

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

describe("environment identity", () => {
  it("creates a permanent ULID on first start and keeps it across restarts", async () => {
    const dir = tempDir();
    const first = start(dir);
    const id = first.store.environmentId;
    expect(isUlid(id)).toBe(true);
    await first.stop();
    cleanups.pop();
    const second = start(dir);
    expect(second.store.environmentId).toBe(id);
    expect(second.service.getEnvironment().id).toBe(id);
    // Another data folder is another environment.
    expect(start().store.environmentId).not.toBe(id);
  });

  it("GET /api/environment describes the host", async () => {
    const { app, store } = start();
    const res = await request(app, "GET", "/api/environment");
    expect(res.status).toBe(200);
    expect((await res.json()) as EnvironmentInfo).toEqual({
      id: store.environmentId,
      name: "Test Mac Studio",
      version: expect.any(String),
      protocol: 2,
      platform: "darwin",
      hostname: "studio.local",
      home: "/Users/test",
      capabilities: { openIn: true, reveal: true, nativeFolderPicker: true, browse: true, remoteAccess: false },
    });
  });

  it("falls back to the host name and has no macOS-only capabilities elsewhere", () => {
    const { service } = start(tempDir(), { platform: "linux", hostname: "box.local", home: "/home/t", machineName: () => null });
    const info = service.getEnvironment();
    expect(info.name).toBe("box");
    expect(info.capabilities).toEqual({ openIn: false, reveal: false, nativeFolderPicker: false, browse: true, remoteAccess: false });
  });

  it("renames (kept across restarts), resets with an empty name and validates", async () => {
    const dir = tempDir();
    const a = start(dir);
    const res = await request(a.app, "PATCH", "/api/environment", { name: "  Work Mac  " });
    expect(res.status).toBe(200);
    expect(((await res.json()) as EnvironmentInfo).name).toBe("Work Mac");
    expect(a.messages).toContainEqual({ type: "environment", environment: expect.objectContaining({ name: "Work Mac" }) });
    expect((await request(a.app, "PATCH", "/api/environment", { name: 3 })).status).toBe(400);
    expect((await request(a.app, "PATCH", "/api/environment", { name: "x".repeat(101) })).status).toBe(400);
    await a.stop();
    cleanups.pop();

    const b = start(dir);
    expect(b.service.getEnvironment().name).toBe("Work Mac");
    expect(((await (await request(b.app, "PATCH", "/api/environment", { name: "" })).json()) as EnvironmentInfo).name).toBe("Test Mac Studio");
    expect(b.store.getEnvironmentName()).toBeNull();
  });

  it("a rename reaches sync clients as a committed shell push; snapshots carry the environment", () => {
    const { service } = start();
    const socket = new TestSocket();
    service.sync.connect(socket).subscribeShell();
    service.sync.tick();
    const snapshot = socket.sent.find((m) => m.type === "snapshot");
    expect(snapshot?.type === "snapshot" && snapshot.scope === "shell" && snapshot.shell.environment?.id).toBe(service.environment.id);
    const live = socket.sent.find((m) => m.type === "live")!;
    socket.sent.length = 0;

    service.renameEnvironment("Renamed");
    service.sync.tick();
    const push = socket.sent.find((m) => m.type === "environment");
    expect(push).toMatchObject({ type: "environment", environment: { name: "Renamed" }, prev: live.seq });
    expect(push!.seq).toBeGreaterThan(live.seq!);

    // A replay after `live` includes it too.
    const again = new TestSocket();
    service.sync.connect(again).subscribeShell(live.seq);
    service.sync.tick();
    expect(again.sent).toContainEqual(expect.objectContaining({ type: "environment", seq: push!.seq }));
  });
});

describe("projects belong to an environment", () => {
  it("new projects get this environment's id; it can't be changed", async () => {
    const { app, store, dir, service } = start();
    const res = await request(app, "POST", "/api/projects", { path: folder(dir, "p") });
    const project = (await res.json()) as Project;
    expect(project.environmentId).toBe(store.environmentId);
    expect(((await (await request(app, "GET", "/api/projects")).json()) as Project[])[0]!.environmentId).toBe(store.environmentId);
    expect(service.shellSnapshot().projects[0]!.environmentId).toBe(store.environmentId);

    expect((await request(app, "PATCH", `/api/projects/${project.id}`, { environmentId: "OTHER" })).status).toBe(400);
    const renamed = (await (await request(app, "PATCH", `/api/projects/${project.id}`, { name: "New" })).json()) as Project;
    expect(renamed).toMatchObject({ name: "New", environmentId: store.environmentId });

    // The store keeps it too (a caller passing another id).
    store.upsertProject({ ...renamed, environmentId: "OTHER" });
    expect(store.getProject(project.id)!.environmentId).toBe(store.environmentId);
    const row = store.db.prepare("SELECT environment_id, data_json FROM projects WHERE id = ?").get(project.id) as { environment_id: string; data_json: string };
    expect(row.environment_id).toBe(store.environmentId);
    expect((JSON.parse(row.data_json) as Project).environmentId).toBe(store.environmentId);
  });

  it("migration 3 backfills projects of an older database", () => {
    const dir = tempDir();
    const dataDir = join(dir, "data");
    mkdirSync(dataDir, { recursive: true });
    // A schema-2 database with two projects (no environment).
    const old = openDatabase(join(dataDir, "glade.db"), MIGRATIONS.filter((m) => m.version <= 2));
    expect(schemaVersion(old)).toBe(2);
    for (const id of ["p1", "p2"]) {
      const p: Project = { id, name: id, path: `/tmp/${id}`, sortOrder: 0, createdAt: 1, lastActivityAt: 1 };
      old.prepare("INSERT INTO projects (id, sort_order, data_json, updated_at) VALUES (?, 0, ?, 1)").run(id, JSON.stringify(p));
    }
    old.close();

    const store = new Store(dataDir, 0, { importJson: false });
    cleanups.push(() => store.dispose());
    expect(schemaVersion(store.db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(isUlid(store.environmentId)).toBe(true);
    expect(store.listProjects().map((p) => p.environmentId)).toEqual([store.environmentId, store.environmentId]);
    const rows = store.db.prepare("SELECT environment_id, data_json FROM projects ORDER BY id").all() as Array<{ environment_id: string; data_json: string }>;
    for (const row of rows) {
      expect(row.environment_id).toBe(store.environmentId);
      expect((JSON.parse(row.data_json) as Project).environmentId).toBe(store.environmentId);
    }
  });

  it("fills in projects an older server writes after the migration", () => {
    const { store } = start();
    const p: Project = { id: "legacy", name: "l", path: "/tmp/l", sortOrder: 0, createdAt: 1, lastActivityAt: 1 };
    store.db.prepare("INSERT INTO projects (id, sort_order, data_json, updated_at) VALUES (?, 0, ?, 1)").run(p.id, JSON.stringify(p));
    store.db.prepare("INSERT INTO events (at, server_id, scope, type, entity_id) VALUES (?, 'old', 'shell', 'project', ?)").run(Date.now(), p.id);
    store.reload();
    expect(store.getProject("legacy")!.environmentId).toBe(store.environmentId);
  });
});

describe("cross-origin access between Glade servers (loopback only, until I-125)", () => {
  const LOOPBACK = ["http://127.0.0.1:5317", "http://localhost:4400", "http://[::1]:9", "https://localhost:1234", "http://127.0.0.1"];
  const FOREIGN = ["https://evil.com", "http://localhost.evil.com", "http://192.168.1.2:4317", "null", "tauri://localhost", "file://"];

  it("classifies origins", () => {
    for (const o of LOOPBACK) expect(isCorsOrigin(o), o).toBe(true);
    for (const o of FOREIGN) expect(isCorsOrigin(o), o).toBe(false);
    expect(isCorsOrigin("http://127.0.0.1:5317/path")).toBe(false);
  });

  it("answers preflights for loopback origins on any port and refuses others", async () => {
    const { app } = start();
    for (const origin of LOOPBACK) {
      const res = await request(app, "OPTIONS", "/api/projects", undefined, {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-glade-command-id",
      });
      expect(res.status, origin).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-methods")).toContain("PATCH");
      expect(res.headers.get("access-control-allow-headers")).toContain(COMMAND_ID_HEADER);
    }
    for (const origin of FOREIGN) {
      const res = await request(app, "OPTIONS", "/api/projects", undefined, { origin, "access-control-request-method": "POST" });
      expect(res.status, origin).toBe(403);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("adds CORS headers to loopback responses (errors and replays included), never to others", async () => {
    const { app, dir } = start();
    const origin = "http://127.0.0.1:5999";
    const ok = await request(app, "GET", "/api/environment", undefined, { origin });
    expect(ok.headers.get("access-control-allow-origin")).toBe(origin);
    expect(ok.headers.get("vary")).toContain("Origin");
    const missing = await request(app, "GET", "/api/sessions/nope", undefined, { origin });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(origin);
    const bad = await request(app, "PATCH", "/api/environment", { name: 1 }, { origin });
    expect(bad.status).toBe(400);
    expect(bad.headers.get("access-control-allow-origin")).toBe(origin);

    const path = folder(dir, "cors");
    const first = await request(app, "POST", "/api/projects", { path }, { origin, [COMMAND_ID_HEADER]: "cmd-1" });
    expect(first.headers.get("access-control-allow-origin")).toBe(origin);
    const replay = await request(app, "POST", "/api/projects", { path }, { origin, [COMMAND_ID_HEADER]: "cmd-1" });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("access-control-allow-origin")).toBe(origin);

    // Other origins: GETs still answer (as before) but browsers can't read them; writes are refused.
    const foreign = await request(app, "GET", "/api/environment", undefined, { origin: "https://evil.com" });
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    expect((await request(app, "PATCH", "/api/environment", { name: "x" }, { origin: "https://evil.com" })).status).toBe(403);
    // No Origin (same-origin fetches, curl): no CORS headers.
    expect((await request(app, "GET", "/api/environment")).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("the WebSocket accepts loopback origins on other ports, says hello with the environment id, refuses others", async () => {
    const { app, injectWebSocket, service } = start();
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    injectWebSocket(server);
    await new Promise<void>((r) => server.once("listening", () => r()));
    cleanups.push(() => server.close());
    const { port } = server.address() as AddressInfo;

    for (const origin of ["http://127.0.0.1:5317", "http://localhost:4400"]) {
      const received: ServerMessage[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
      ws.on("message", (data) => received.push(JSON.parse(String(data)) as ServerMessage));
      await new Promise((r, j) => ws.once("open", r).once("error", j));
      await until(() => received.length > 0);
      expect(received[0]).toEqual({ type: "hello", version: expect.any(String), protocol: 2, environmentId: service.environment.id });
      ws.close();
    }

    for (const origin of ["https://evil.com", "http://192.168.1.2:5317"]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
      const status = await new Promise<number>((resolve) => {
        ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.once("error", () => resolve(-1));
      });
      expect(status, origin).toBe(403);
    }
  });
});

describe("export download (I-123: clients not on the host)", () => {
  it("GET /api/sessions/:id/export/download returns the HTML file as an attachment, readable cross-origin", async () => {
    const { app, service } = start();
    const created = await service.createWorkspace({ projectId: null });
    const origin = "http://localhost:5317";
    const res = await request(app, "GET", `/api/sessions/${created.session.session.id}/export/download`, undefined, { origin });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="glade-fake-export-.*\.html"/);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-expose-headers")).toContain("content-disposition");
    expect(await res.text()).toContain("Fake export");
    expect((await request(app, "GET", "/api/sessions/nope/export/download")).status).toBe(404);
  });
});
