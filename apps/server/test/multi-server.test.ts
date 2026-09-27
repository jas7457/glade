/**
 * I-062: two servers on one data folder. Two AppServices share a temp data dir (and one
 * FakeHarness, standing in for pi's session files on disk): changes travel through the watched
 * store, writes don't get lost, and session leases keep a session's agent in one server.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@glade/protocol";
import { FakeHarness, type FakeSession } from "../src/harness/fake/fake-harness.js";
import { AppService, HttpError } from "../src/services/app-service.js";
import { LeaseManager } from "../src/services/leases.js";
import { ServerRegistry } from "../src/services/server-registry.js";
import { JsonFile } from "../src/store/json-file.js";
import { Store } from "../src/store/store.js";
import { until } from "./helpers.js";

interface Server {
  store: Store;
  registry: ServerRegistry;
  service: AppService;
  messages: ServerMessage[];
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "glade-multi-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function startServer(dir: string, harness: FakeHarness, id: string, kind: string, debounceMs = 0): Server {
  const dataDir = join(dir, "data");
  const store = new Store(dataDir, debounceMs);
  const registry = new ServerRegistry(dataDir, { kind, host: "127.0.0.1", port: 0, id });
  registry.start();
  const service = new AppService({ store, harness, scratchDir: join(dir, "scratch"), dataDir, registry, leaseScanMs: 40 });
  const messages: ServerMessage[] = [];
  service.subscribe((m) => messages.push(m));
  cleanups.push(async () => {
    await service.dispose();
    registry.release();
  });
  return { store, registry, service, messages };
}

function pair(debounceMs = 0) {
  const dir = tempDir();
  const harness = new FakeHarness();
  const a = startServer(dir, harness, "A", "desktop", debounceMs);
  const b = startServer(dir, harness, "B", "dev", debounceMs);
  return { dir, harness, a, b };
}

function fakeSessionFor(harness: FakeHarness, sessionRef: string | null): FakeSession {
  const session = [...harness.openSessions].find((s) => s.sessionRef === sessionRef);
  if (!session) throw new Error(`no open fake session for ${sessionRef}`);
  return session;
}

describe("two servers on one data folder (I-062)", () => {
  it("a chat created in one server appears in the other via the watcher", async () => {
    const { a, b } = pair();
    const created = await a.service.createWorkspace({ projectId: null, prompt: "hello" });
    await until(() => b.service.listWorkspaces().some((w) => w.id === created.workspace.id), 4000);
    await until(() => b.messages.some((m) => m.type === "workspace_upsert" && m.workspace.id === created.workspace.id), 4000);
    expect(b.messages.some((m) => m.type === "session_upsert" && m.session.id === created.session.session.id)).toBe(true);

    // Renames and deletes travel too.
    await a.service.updateWorkspace(created.workspace.id, { title: "Renamed in A" });
    await until(() => b.service.listWorkspaces().find((w) => w.id === created.workspace.id)?.title === "Renamed in A", 4000);
    await a.service.deleteWorkspace(created.workspace.id);
    await until(() => b.messages.some((m) => m.type === "workspace_removed" && m.workspaceId === created.workspace.id), 4000);
    expect(b.service.listWorkspaces()).toEqual([]);
  });

  it("settings changed in one server reach the other's clients", async () => {
    const { a, b } = pair();
    a.service.updateSettings({ general: { sendKey: "mod-enter" } });
    await until(() => b.messages.some((m) => m.type === "settings" && m.settings.general.sendKey === "mod-enter"), 4000);
    expect(b.service.getSettings().general.sendKey).toBe("mod-enter");
  });

  it("concurrent edits from both servers don't lose writes", async () => {
    // Debounced writes: both servers change the same files before either has seen the other's.
    const { dir, a, b } = pair(30);
    const wa = await a.service.createWorkspace({ projectId: null });
    const wb = await b.service.createWorkspace({ projectId: null });
    await a.service.updateWorkspace(wa.workspace.id, { title: "From A" });
    await b.service.updateWorkspace(wb.workspace.id, { title: "From B" });
    a.service.updateSettings({ general: { sendKey: "mod-enter" } });
    b.service.updateSettings({ models: { hiddenModels: ["fake/fast"] } });
    a.store.flush();
    b.store.flush();

    const fresh = new Store(join(dir, "data"), 0);
    const titles = Object.fromEntries(fresh.listWorkspaces().map((w) => [w.id, w.title]));
    expect(titles).toEqual({ [wa.workspace.id]: "From A", [wb.workspace.id]: "From B" });
    expect(fresh.listSessions().map((s) => s.id).sort()).toEqual([wa.session.session.id, wb.session.session.id].sort());
    expect(fresh.getSettings().general.sendKey).toBe("mod-enter");
    expect(fresh.getSettings().models.hiddenModels).toEqual(["fake/fast"]);
    // And each server ends up with the other's changes as well.
    await until(() => a.service.listWorkspaces().length === 2 && b.service.listWorkspaces().length === 2, 4000);
  });

  it("interleaved read-modify-writes on one file keep every change", () => {
    const path = join(tempDir(), "shared.json");
    const one = new JsonFile<{ items: number[] }>(path, () => ({ items: [] }), 10_000);
    const two = new JsonFile<{ items: number[] }>(path, () => ({ items: [] }), 10_000);
    for (let i = 0; i < 50; i++) {
      one.update((f) => ({ items: [...f.items, i] }));
      two.update((f) => ({ items: [...f.items, 100 + i] }));
      if (i % 7 === 0) one.flush();
      if (i % 5 === 0) two.flush();
    }
    one.flush();
    two.flush();
    const items = (JSON.parse(readFileSync(path, "utf8")) as { items: number[] }).items;
    expect(items).toHaveLength(100);
    expect(new Set(items).size).toBe(100);
  });

  it("a session running in one server is active elsewhere in the other and can't be prompted there", async () => {
    const { harness, a, b } = pair();
    const created = await a.service.createWorkspace({ projectId: null });
    const sid = created.session.session.id;
    const ref = a.service.listSessions().find((s) => s.id === sid)!.sessionRef;
    await until(() => b.service.listSessions().some((s) => s.id === sid), 4000);

    // Start a run in A (and keep it going).
    fakeSessionFor(harness, ref).emit({ type: "run_start" });
    await until(() => b.service.listSessions().find((s) => s.id === sid)?.activeElsewhere !== undefined, 4000);
    const inB = b.service.listSessions().find((s) => s.id === sid)!;
    expect(inB.activeElsewhere).toMatchObject({ serverKind: "desktop" });
    expect(inB.status).toBe("working");
    expect(b.service.listWorkspaces()[0]!.status).toBe("working");
    expect(b.messages.some((m) => m.type === "session_upsert" && m.session.id === sid && m.session.activeElsewhere)).toBe(true);

    // B shows it read-only (no second agent process) and refuses prompts with a clear 409.
    const openBefore = harness.openSessions.size;
    const detail = await b.service.getSessionDetail(sid);
    expect(detail.session.activeElsewhere).toBeDefined();
    expect(harness.openSessions.size).toBe(openBefore);
    const err = await b.service.prompt(sid, { text: "hi from B" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).message).toBe("Running in Glade — open it there or wait until it's idle");
    await expect(b.service.deleteWorkspace(created.workspace.id)).rejects.toMatchObject({ status: 409 });
    await expect(b.service.abort(sid)).rejects.toMatchObject({ status: 409 });

    // The run ends in A: B clears the flag, and B may now take the (idle) session over.
    fakeSessionFor(harness, ref).emit({ type: "run_end" });
    await until(() => b.service.listSessions().find((s) => s.id === sid)?.activeElsewhere === undefined, 4000);
    await b.service.prompt(sid, { text: "now B" });
    expect(a.service.liveCount).toBe(0); // A handed it over (stopped its idle process)
    expect(b.service.liveCount).toBe(1);
  });

  it("a run in progress isn't marked interrupted when the other server starts", async () => {
    const dir = tempDir();
    const harness = new FakeHarness();
    const a = startServer(dir, harness, "A", "desktop");
    const created = await a.service.createWorkspace({ projectId: null });
    const sid = created.session.session.id;
    fakeSessionFor(harness, a.service.listSessions()[0]!.sessionRef).emit({ type: "run_start" });
    const b = startServer(dir, harness, "B", "dev");
    const inB = b.service.listSessions().find((s) => s.id === sid)!;
    expect(inB.interrupted).toBeUndefined();
    expect(inB.runInProgress).toBe(true);
  });

  it("takes over a session whose server died (stale lease) and marks its run interrupted", async () => {
    const dir = tempDir();
    const harness = new FakeHarness();
    const b = startServer(dir, harness, "B", "dev");
    const created = await b.service.createWorkspace({ projectId: null });
    const sid = created.session.session.id;
    // Hand the session to a "ghost" server that then died mid-run: its pid is gone.
    const dataDir = join(dir, "data");
    const deadPid = spawnSync("true").pid!;
    const ghost = new ServerRegistry(dataDir, { kind: "desktop", host: "127.0.0.1", port: 1, id: "ghost", pid: deadPid, heartbeatMs: 0 });
    ghost.start();
    // B closes its process so the ghost can hold the lease.
    await (b.service as unknown as { closeLive(id: string): Promise<void> }).closeLive(sid);
    const ghostLeases = new LeaseManager(dataDir, ghost, { scanMs: 0 });
    expect(ghostLeases.claim(sid, { running: true, pendingInputs: 0 })).toEqual({ ok: true });
    b.store.upsertSession({ ...b.store.getSession(sid)!, runInProgress: true });

    // The ghost's pid is dead, so B sees a stale lease: not active elsewhere, and the orphaned
    // run is marked interrupted after a short grace; prompting takes the session over.
    await until(() => b.service.listSessions().find((s) => s.id === sid)?.interrupted === true, 4000);
    expect(b.service.listSessions().find((s) => s.id === sid)!.activeElsewhere).toBeUndefined();
    await b.service.prompt(sid, { text: "continue" });
    expect(b.service.liveCount).toBe(1);
    const lease = JSON.parse(readFileSync(join(dataDir, "leases", `${sid}.json`), "utf8")) as { serverId: string };
    expect(lease.serverId).toBe("B");
    ghost.release();
  });

  it("registers each server under servers/ and removes it on release", async () => {
    const { dir, a, b } = pair();
    const dataDir = join(dir, "data");
    expect(a.registry.others().map((s) => s.id)).toEqual(["B"]);
    expect(b.registry.others().map((s) => s.kind)).toEqual(["desktop"]);
    b.registry.release();
    expect(a.registry.others()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dataDir, "servers", "A.json"), "utf8"))).toMatchObject({ id: "A", kind: "desktop" });
  });
});
