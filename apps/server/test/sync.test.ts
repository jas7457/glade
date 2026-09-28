/**
 * I-122: sequenced live sync. The hub is driven through a fake socket (and once through a real
 * WebSocket): replay after N events, snapshot fallbacks, batching and the size budget, pings,
 * per-session transcript sync that ends in the stored state, command ids, and two servers on one
 * data folder.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  applyAgentEvent,
  classifySeq,
  COMMAND_ID_HEADER,
  emptyTranscript,
  type ServerMessage,
  type Transcript,
} from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { createApp } from "../src/http/app.js";
import { AppService } from "../src/services/app-service.js";
import { ServerRegistry } from "../src/services/server-registry.js";
import type { SyncOptions, SyncSocket } from "../src/services/sync/hub.js";
import { Store } from "../src/store/store.js";
import { flush, until } from "./helpers.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "glade-sync-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function startService(sync: SyncOptions = {}, dir = tempDir(), shared?: { harness: FakeHarness; id: string }) {
  const dataDir = join(dir, "data");
  const store = new Store(dataDir, 0);
  const harness = shared?.harness ?? new FakeHarness();
  const registry = shared ? new ServerRegistry(dataDir, { kind: shared.id === "A" ? "desktop" : "dev", host: "127.0.0.1", port: 0, id: shared.id }) : undefined;
  registry?.start();
  const service = new AppService({
    store,
    harnesses: new HarnessRegistry([harness]),
    scratchDir: join(dir, "scratch"),
    dataDir,
    registry,
    leaseScanMs: 40,
    sync: { batchMs: 10_000, ...sync }, // tests tick by hand
  });
  cleanups.push(async () => {
    await service.dispose();
    registry?.release();
  });
  return { dir, store, harness, service };
}

/** A fake socket that records what the hub sends. */
class TestSocket implements SyncSocket {
  readonly frames: ServerMessage[][] = [];
  buffered = 0;
  closed = false;
  send(data: string): void {
    const message = JSON.parse(data) as ServerMessage;
    this.frames.push(message.type === "batch" ? message.messages : [message]);
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  close(): void {
    this.closed = true;
  }
  get all(): ServerMessage[] {
    return this.frames.flat();
  }
  take(): ServerMessage[] {
    const out = this.all;
    this.frames.length = 0;
    return out;
  }
}

/**
 * What a client does with a session scope's pushes (the web's rule, simplified): the transcript it
 * ends up with, and its last seq.
 */
function follow(messages: ServerMessage[], sessionId: string, from: { last: number | null; transcript: Transcript }) {
  let { last, transcript } = from;
  const verdicts: string[] = [];
  for (const m of messages) {
    if (m.type === "snapshot" && m.scope === "session" && m.sessionId === sessionId) {
      transcript = { messages: m.page.messages, toolResults: m.page.toolResults };
      last = m.seq;
      continue;
    }
    if (m.type === "live" && m.scope === "session" && m.sessionId === sessionId) {
      last = m.seq;
      continue;
    }
    const mine = (m.type === "session_event" || m.type === "transcript_patch" || m.type === "session_sync") && m.sessionId === sessionId;
    if (!mine) continue;
    const verdict = classifySeq(last, m);
    verdicts.push(verdict);
    if (verdict !== "apply") continue;
    if (m.prev !== undefined) last = m.seq!;
    if (m.type === "session_event") transcript = applyAgentEvent(transcript, m.event);
    if (m.type === "transcript_patch") {
      const messages = transcript.messages.slice();
      for (const p of m.messages) {
        const at = messages.findIndex((x) => x.id === p.message.id);
        if (at !== -1) messages[at] = p.message;
        else messages.splice(p.index, 0, p.message);
      }
      transcript = { messages, toolResults: { ...transcript.toolResults, ...Object.fromEntries(m.toolResults.map((r) => [r.toolCallId, r])) } };
    }
  }
  return { last, transcript, verdicts };
}

/** Wait until the fake agent answered `text` and the run is over. */
async function answered(service: AppService, store: Store, sid: string, text: string): Promise<void> {
  await until(() => {
    const done = store.loadTranscript(sid).messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes(`You said: ${text}`));
    return done && !service.listSessions().find((s) => s.id === sid)?.running;
  }, 4000);
}

/** Message texts (for comparing transcripts without volatile fields). */
function texts(t: Transcript): string[] {
  return t.messages.map((m) => `${m.id}:${m.role}:${JSON.stringify("content" in m ? m.content : m)}`);
}

describe("sequenced sync: shell scope (I-122)", () => {
  it("subscribing without afterSeq sends a snapshot, then live, then tagged pushes in seq order", async () => {
    const { service, store } = startService();
    const created = await service.createWorkspace({ projectId: null });
    const socket = new TestSocket();
    const client = service.sync.connect(socket);
    client.subscribeShell();
    service.sync.tick();
    const first = socket.take();
    expect(first.map((m) => m.type)).toEqual(["snapshot", "live"]);
    const snapshot = first[0] as Extract<ServerMessage, { type: "snapshot"; scope: "shell" }>;
    expect(snapshot.seq).toBe(store.headSeq);
    expect(snapshot.shell.workspaces.map((w) => w.id)).toEqual([created.workspace.id]);
    expect((first[1] as Extract<ServerMessage, { type: "live"; scope: "shell" }>).check.sessions).toEqual([created.session.session.id]);

    await service.updateWorkspace(created.workspace.id, { title: "Renamed" });
    service.createProject({ path: tempDir(), name: "P" });
    service.sync.tick();
    const pushes = socket.take();
    let last: number | null = snapshot.seq;
    for (const m of pushes) {
      expect(m.seq).toBeTypeOf("number");
      expect(classifySeq(last, m)).toBe("apply");
      if (m.prev !== undefined) last = m.seq!;
    }
    expect(last).toBe(store.headSeq);
    expect(pushes).toContainEqual(expect.objectContaining({ type: "workspace_upsert", workspace: expect.objectContaining({ title: "Renamed" }) }));
    expect(pushes.some((m) => m.type === "project_upsert")).toBe(true);
    // Coalesced: one push per entity per batch.
    expect(pushes.filter((m) => m.type === "workspace_upsert").length).toBe(1);
  });

  it("a client that comes back after N events gets them replayed (no snapshot) and ends in the same state", async () => {
    const { service, store } = startService();
    const created = await service.createWorkspace({ projectId: null });
    const s1 = new TestSocket();
    const c1 = service.sync.connect(s1);
    c1.subscribeShell();
    service.sync.tick();
    const seenAt = (s1.take().find((m) => m.type === "live") as { seq: number }).seq;
    c1.dispose(); // connection dropped

    for (let i = 0; i < 20; i++) await service.updateWorkspace(created.workspace.id, { title: `Title ${i}` });
    const other = await service.createWorkspace({ projectId: null });
    await service.deleteWorkspace(other.workspace.id);

    const s2 = new TestSocket();
    const c2 = service.sync.connect(s2);
    c2.subscribeShell(seenAt);
    service.sync.tick();
    const replay = s2.take();
    expect(replay.some((m) => m.type === "snapshot")).toBe(false);
    let last: number | null = seenAt;
    for (const m of replay) {
      if (m.type === "live") {
        last = m.seq;
        continue;
      }
      expect(classifySeq(last, m)).toBe("apply");
      if (m.prev !== undefined) last = m.seq!;
    }
    expect(last).toBe(store.headSeq);
    // Current state only (one push per entity), the deleted workspace as removed.
    expect(replay.filter((m) => m.type === "workspace_upsert")).toEqual([expect.objectContaining({ workspace: expect.objectContaining({ title: "Title 19" }) })]);
    expect(replay).toContainEqual(expect.objectContaining({ type: "workspace_removed", workspaceId: other.workspace.id }));
    const live = replay.find((m) => m.type === "live") as Extract<ServerMessage, { type: "live"; scope: "shell" }>;
    expect(live.check.workspaces).toEqual([created.workspace.id]);
  });

  it("falls back to a snapshot when the gap is too big, the events were pruned, or afterSeq is ahead", async () => {
    const { service, store } = startService({ maxReplay: 5 });
    const created = await service.createWorkspace({ projectId: null });
    const from = store.headSeq;
    for (let i = 0; i < 10; i++) await service.updateWorkspace(created.workspace.id, { title: `T${i}` });

    const subscribe = (afterSeq: number) => {
      const socket = new TestSocket();
      service.sync.connect(socket).subscribeShell(afterSeq);
      service.sync.tick();
      return socket.take().map((m) => m.type);
    };
    expect(subscribe(from)[0]).toBe("snapshot"); // > maxReplay rows
    expect(subscribe(store.headSeq - 2)[0]).not.toBe("snapshot"); // small gap: replay
    expect(subscribe(store.headSeq + 50)[0]).toBe("snapshot"); // from another database
    store.db.prepare("DELETE FROM events WHERE seq <= ?").run(store.headSeq - 1); // pruned
    expect(subscribe(store.headSeq - 3)[0]).toBe("snapshot");
  });

  it("batches pushes per client and falls back to snapshots when a slow client exceeds its budget", async () => {
    const { service } = startService({ budgetBytes: 2000 });
    const created = await service.createWorkspace({ projectId: null });
    const socket = new TestSocket();
    const client = service.sync.connect(socket);
    client.subscribeShell();
    service.sync.tick();
    socket.take();

    for (let i = 0; i < 3; i++) await service.updateWorkspace(created.workspace.id, { title: `Batch ${i}` });
    service.sync.tick();
    expect(socket.frames.length).toBe(1); // one frame per batch
    socket.take();

    // The socket's own buffer is full: nothing is queued up; once it drained, a snapshot follows.
    socket.buffered = 10_000;
    for (let i = 0; i < 3; i++) await service.updateWorkspace(created.workspace.id, { title: `Slow ${i}` });
    service.sync.tick();
    expect(socket.frames.length).toBe(0);
    socket.buffered = 0;
    service.sync.tick();
    const recovered = socket.take();
    expect(recovered.map((m) => m.type)).toEqual(["snapshot", "live"]);
    const snap = recovered[0] as Extract<ServerMessage, { type: "snapshot"; scope: "shell" }>;
    expect(snap.shell.workspaces[0]!.title).toBe("Slow 2");
  });

  it("pings, and closes a client that stopped answering", async () => {
    const { service } = startService({ pingMs: 1, deadMs: 40 });
    const socket = new TestSocket();
    const client = service.sync.connect(socket);
    await flush(5);
    service.sync.tick();
    expect(socket.all.some((m) => m.type === "ping")).toBe(true);
    client.seen(); // a pong
    await flush(20);
    service.sync.tick();
    expect(socket.closed).toBe(false);
    await flush(45);
    service.sync.tick();
    expect(socket.closed).toBe(true);
    expect(service.sync.clientCount).toBe(0);
  });
});

describe("sequenced sync: session scope (I-122)", () => {
  it("the live stream (deltas + markers) and a later replay both end in the stored transcript", async () => {
    const { service, store, harness } = startService();
    harness.eventDelayMs = 1;
    const created = await service.createWorkspace({ projectId: null });
    const sid = created.session.session.id;
    const socket = new TestSocket();
    const client = service.sync.connect(socket);
    await client.subscribeSession(sid);
    service.sync.tick();
    let view = follow(socket.take(), sid, { last: null, transcript: emptyTranscript() });
    expect(view.last).toBe(store.headSeq);

    await service.prompt(sid, { text: "first" });
    await answered(service, store, sid, "first");
    service.sync.tick();
    const streamed = socket.take();
    expect(streamed.some((m) => m.type === "session_sync")).toBe(true); // markers for this server's writes
    expect(streamed.some((m) => m.type === "transcript_patch")).toBe(false); // content came as events
    view = follow(streamed, sid, view);
    expect(view.verdicts.every((v) => v === "apply")).toBe(true);
    expect(texts(view.transcript)).toEqual(texts(store.loadTranscript(sid)));

    // Dropped connection: two more runs meanwhile, then a resubscribe from the last seq.
    client.dispose();
    await service.prompt(sid, { text: "second" });
    await answered(service, store, sid, "second");
    await service.prompt(sid, { text: "third" });
    await answered(service, store, sid, "third");
    const again = new TestSocket();
    await service.sync.connect(again).subscribeSession(sid, view.last!);
    service.sync.tick();
    const replay = again.take();
    expect(replay.map((m) => m.type)).toEqual(["transcript_patch", "live"]);
    const caught = follow(replay, sid, view);
    expect(caught.last).toBe(store.headSeq);
    expect(texts(caught.transcript)).toEqual(texts(store.loadTranscript(sid)));
    expect(caught.transcript.messages.filter((m) => m.role === "user").length).toBe(3);
  });

  it("subscribing mid-stream writes pending changes first, so the stream continues without holes", async () => {
    const { service, store, harness } = startService();
    const created = await service.createWorkspace({ projectId: null });
    const sid = created.session.session.id;
    harness.eventDelayMs = 3;
    harness.script = (req, nextId) => {
      const id = nextId();
      const words = Array.from({ length: 30 }, (_, i) => `w${i} `);
      return [
        { type: "message_start", message: { id, role: "assistant", content: [], timestamp: Date.now(), streaming: true } },
        { type: "block_start", messageId: id, index: 0, block: { type: "text", text: "" } },
        ...words.map((delta) => ({ type: "block_delta" as const, messageId: id, index: 0, delta })),
        { type: "message_end", message: { id, role: "assistant", content: [{ type: "text", text: words.join("") }], timestamp: Date.now(), stopReason: "stop" } },
      ];
    };
    await service.prompt(sid, { text: "stream" });
    await flush(30); // halfway through
    const socket = new TestSocket();
    const client = service.sync.connect(socket);
    await client.subscribeSession(sid);
    await until(() => store.loadTranscript(sid).messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("w29")), 4000);
    await until(() => !service.listSessions().find((s) => s.id === sid)?.running, 4000);
    service.sync.tick();
    const all = socket.take();
    const view = follow(all, sid, { last: null, transcript: emptyTranscript() });
    expect(view.verdicts.every((v) => v === "apply")).toBe(true);
    const answer = view.transcript.messages.at(-1)!;
    expect(answer.role === "assistant" && answer.content[0]?.type === "text" && answer.content[0].text).toBe(Array.from({ length: 30 }, (_, i) => `w${i} `).join(""));
    expect(texts(view.transcript)).toEqual(texts(store.loadTranscript(sid)));
  });

  it("a harness file merged in goes out as a patch, or as a snapshot when messages moved", async () => {
    const { service, store } = startService();
    const created = await service.createWorkspace({ projectId: null });
    const sid = created.session.session.id;
    await service.prompt(sid, { text: "first" });
    await answered(service, store, sid, "first");
    const socket = new TestSocket();
    const client = service.sync.connect(socket);
    await client.subscribeSession(sid);
    service.sync.tick();
    // (Imports only happen while no process runs the session here.)
    await (service as unknown as { closeLive(id: string): Promise<void> }).closeLive(sid);
    await flush(5);
    service.sync.tick();
    let view = follow(socket.take(), sid, { last: null, transcript: emptyTranscript() });

    const stored = store.loadTranscript(sid);
    const notice = (id: string, timestamp: number) => ({ id, role: "notice" as const, kind: "info" as const, text: `note ${id}`, timestamp });
    store.importTranscript(sid, { ...stored, messages: [...stored.messages, notice("n1", Date.now())] }, { source: "fake", sig: null });
    service.sync.tick();
    const appended = socket.take();
    expect(appended.map((m) => m.type)).toEqual(["transcript_patch"]);
    view = follow(appended, sid, view);
    expect(texts(view.transcript)).toEqual(texts(store.loadTranscript(sid)));

    const now = store.loadTranscript(sid);
    store.importTranscript(sid, { ...now, messages: [notice("n0", 1), ...now.messages] }, { source: "fake", sig: null });
    await until(() => {
      service.sync.tick();
      return socket.all.some((m) => m.type === "live");
    });
    const moved = socket.take();
    expect(moved.map((m) => m.type).filter((t) => t !== "session_event")).toEqual(["snapshot", "live"]);
    view = follow(moved, sid, view);
    expect(texts(view.transcript)).toEqual(texts(store.loadTranscript(sid)));
  });

  it("snapshots are paged by turn, and earlier turns load through the transcript API", async () => {
    const { service } = startService({ snapshotTurns: 2 });
    const created = await service.createWorkspace({ projectId: null });
    const sid = created.session.session.id;
    for (const text of ["one", "two", "three"]) {
      await service.prompt(sid, { text });
      await answered(service, service.store, sid, text);
    }
    const socket = new TestSocket();
    await service.sync.connect(socket).subscribeSession(sid);
    service.sync.tick();
    const snap = socket.all.find((m) => m.type === "snapshot") as Extract<ServerMessage, { type: "snapshot"; scope: "session" }>;
    expect(snap.page.messages.filter((m) => m.role === "user").length).toBe(2);
    expect(snap.page.start).toBeGreaterThan(0);
    expect(snap.page.total).toBe(snap.page.start + snap.page.messages.length);
    const earlier = await service.getTranscriptPage(sid, snap.page.start, 50);
    expect(earlier.start).toBe(0);
    expect(earlier.messages.length).toBe(snap.page.start);
    expect(Object.keys(earlier.toolResults).length).toBe(1); // the first turn's bash call
  });
});

describe("command ids (I-122)", () => {
  it("a retried request with the same commandId isn't applied twice", async () => {
    const { service, harness } = startService();
    const { app } = createApp({ service });
    const post = (path: string, body: unknown, id?: string) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", host: "127.0.0.1", ...(id ? { [COMMAND_ID_HEADER]: id } : {}) },
        body: JSON.stringify(body),
      });

    const first = await post("/api/workspaces", { projectId: null }, "cmd-1");
    const retry = await post("/api/workspaces", { projectId: null }, "cmd-1");
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("x-glade-command-replayed")).toBe("1");
    const created = (await first.json()) as { workspace: { id: string }; session: { session: { id: string } } };
    expect(((await retry.json()) as { workspace: { id: string } }).workspace.id).toBe(created.workspace.id);
    expect(service.listWorkspaces().length).toBe(1);

    // Prompts: the body field works too; sent once.
    const sid = created.session.session.id;
    expect((await post(`/api/sessions/${sid}/prompt`, { text: "once", commandId: "cmd-2" })).status).toBe(204);
    expect((await post(`/api/sessions/${sid}/prompt`, { text: "once", commandId: "cmd-2" })).status).toBe(204);
    await until(() => !service.listSessions().find((s) => s.id === sid)?.running);
    const fake = [...harness.openSessions].find((s) => s.sessionRef === service.listSessions()[0]!.sessionRef)!;
    expect(fake.prompts.map((p) => p.text)).toEqual(["once"]);

    // Reused on another route: refused. A failed request is forgotten (the retry runs).
    expect((await post("/api/projects", { path: tempDir() }, "cmd-1")).status).toBe(409);
    expect((await post(`/api/sessions/${sid}/prompt`, { nope: true }, "cmd-3")).status).toBe(400);
    expect((await post(`/api/sessions/${sid}/prompt`, { text: "retry" }, "cmd-3")).status).toBe(204);
  });
});

describe("two servers on one data folder (I-122)", () => {
  it("a client of server B receives A's changes with A's seqs, including a transcript A streams", async () => {
    const dir = tempDir();
    const harness = new FakeHarness();
    const a = startService({}, dir, { harness, id: "A" });
    const b = startService({}, dir, { harness, id: "B" });
    const socket = new TestSocket();
    const client = b.service.sync.connect(socket);
    client.subscribeShell();
    b.service.sync.tick();
    socket.take();

    const created = await a.service.createWorkspace({ projectId: null });
    const sid = created.session.session.id;
    const rowSeq = a.store.headSeq;
    await until(() => {
      b.service.sync.tick();
      return socket.all.some((m) => m.type === "session_upsert" && m.session.id === sid);
    }, 4000);
    const upsert = socket.all.find((m) => m.type === "workspace_upsert" && m.workspace.id === created.workspace.id)!;
    expect(upsert.seq).toBeLessThanOrEqual(rowSeq);
    expect(upsert.prev).toBeTypeOf("number");

    // B's client opens the chat A runs, then A streams a reply into it.
    await until(() => b.service.listSessions().some((s) => s.id === sid), 4000);
    await client.subscribeSession(sid);
    b.service.sync.tick();
    let view = follow(socket.take(), sid, { last: null, transcript: emptyTranscript() });
    await a.service.prompt(sid, { text: "from A" });
    await answered(a.service, a.store, sid, "from A");
    await until(() => {
      b.service.sync.tick();
      view = follow(socket.take(), sid, view);
      return view.transcript.messages.some((m) => m.role === "user");
    }, 4000);
    await until(() => {
      b.service.store.reload();
      b.service.sync.tick();
      view = follow(socket.take(), sid, view);
      return texts(view.transcript).join() === texts(a.store.loadTranscript(sid)).join();
    }, 4000);
    expect(view.verdicts.every((v) => v === "apply")).toBe(true);
    expect(view.last).toBeGreaterThan(0);
  });
});

describe("sequenced sync over a real WebSocket (I-122)", () => {
  it("subscribes, answers pings and pushes batches", async () => {
    const { service } = startService({ batchMs: 20 });
    await service.createWorkspace({ projectId: null });
    const { app, injectWebSocket } = createApp({ service });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    injectWebSocket(server);
    await new Promise<void>((r) => server.once("listening", () => r()));
    cleanups.push(() => void server.close());
    const { port } = server.address() as AddressInfo;
    const received: ServerMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://localhost:5317" });
    ws.on("message", (data) => {
      const m = JSON.parse(String(data)) as ServerMessage;
      received.push(...(m.type === "batch" ? m.messages : [m]));
    });
    await new Promise((r, j) => ws.once("open", r).once("error", j));
    cleanups.push(() => ws.close());
    ws.send(JSON.stringify({ type: "subscribe", scope: "shell" }));
    await until(() => received.some((m) => m.type === "live"));
    expect(received.map((m) => m.type).slice(0, 3)).toEqual(["hello", "snapshot", "live"]);
    ws.send(JSON.stringify({ type: "ping", t: 7 }));
    await until(() => received.some((m) => m.type === "pong"));
    await service.createWorkspace({ projectId: null });
    await until(() => received.filter((m) => m.type === "workspace_upsert").length > 0);
    expect(received.filter((m) => m.type === "workspace_upsert").every((m) => typeof m.seq === "number")).toBe(true);
  });
});
