/**
 * I-157/I-163 end to end: `GET /api/blobs/<sessionId>/<name>` and legacy `/api/blobs/<hash>`
 * (local owner, paired device, unauthenticated, path traversal), a live run whose tool result has
 * an image (stored in the chat's folder, pushed and replayed as a reference), the harness being
 * fed real image data for prompts sent inline or by reference, and deleting a chat, a sub-agent
 * or a project deleting the images.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyAgentEvent, blobUrlPath, emptyTranscript, type PairingInvite, type PairResponse, type ServerMessage, type Transcript } from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { fakePng } from "../src/harness/fake/fake-image.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { createApp } from "../src/http/app.js";
import { AppService } from "../src/services/app-service.js";
import { AuthService } from "../src/services/auth/auth-service.js";
import type { SyncSocket } from "../src/services/sync/hub.js";
import { Store } from "../src/store/store.js";
import { until } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const HOST = "127.0.0.1:4317";
const OTHER = "http://127.0.0.1:4400";

function start() {
  const dir = mkdtempSync(join(tmpdir(), "glade-blobs-live-"));
  const store = new Store(join(dir, "data"), 0);
  const harness = new FakeHarness();
  const service = new AppService({ store, harnesses: new HarnessRegistry([harness]), scratchDir: join(dir, "scratch"), sync: { batchMs: 10_000 } });
  const auth = new AuthService({
    db: store.db,
    environmentId: service.environment.id,
    environmentName: () => "Test Host",
    addresses: () => ["http://127.0.0.1:4317"],
    watchMs: 0,
    pairTimeoutMs: 5000,
    pairPollMs: 5,
    tailscaleLogin: async () => null,
  });
  const { app } = createApp({ service, auth, ownPorts: () => [4317, 5317] });
  cleanups.push(async () => {
    auth.dispose();
    await service.dispose();
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (method: string, path: string, o: { body?: unknown; headers?: Record<string, string>; token?: string } = {}) =>
    app.request(
      path,
      {
        method,
        headers: {
          host: HOST,
          ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
          ...o.headers,
        },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
  const remote = (method: string, path: string, o: { body?: unknown; token?: string } = {}) => call(method, path, { ...o, headers: { origin: OTHER } });
  const pairDevice = async (): Promise<string> => {
    expect((await call("PATCH", "/api/auth/remote", { body: { enabled: true } })).status).toBe(200);
    const invite = (await (await call("POST", "/api/auth/invites")).json()) as PairingInvite;
    const grant = new URL(invite.link.replace("glade://", "http://x/")).searchParams.get("g")!;
    const pending = remote("POST", "/api/auth/pair", { body: { grant, deviceName: "Laptop", deviceKind: "mac" } });
    for (let i = 0; i < 400; i++) {
      const list = (await (await call("GET", "/api/auth/pending")).json()) as { id: string }[];
      if (list.length) {
        await call("POST", `/api/auth/pending/${list[0]!.id}`, { body: { allow: true } });
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const body = (await (await pending).json()) as PairResponse;
    if (body.status !== "paired") throw new Error(`not paired: ${JSON.stringify(body)}`);
    return body.token;
  };
  return { store, harness, service, call, remote, pairDevice };
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

describe("GET /api/blobs/... (I-157/I-163)", () => {
  it("serves chat images immutably to the local owner and paired devices; others get 401; no traversal", async () => {
    const { store, call, remote, pairDevice } = start();
    const png = fakePng(3, 12, 8);
    const { ref } = store.blobs.put("chat-1", png, "image/png");
    const path = `/api/blobs/${blobUrlPath(ref)}`;
    expect(path).toMatch(/^\/api\/blobs\/chat-1\/[0-9a-f]{16}$/);

    const res = await call("GET", path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
    expect((await call("GET", `/api/blobs/${encodeURIComponent(ref)}`)).status).toBe(200);
    expect((await call("GET", path, { headers: { "if-none-match": res.headers.get("etag")! } })).status).toBe(304);
    expect((await call("GET", "/api/blobs/chat-1/0000000000000000")).status).toBe(404);
    expect((await call("GET", "/api/blobs/chat-2/0000000000000000")).status).toBe(404);
    for (const bad of ["..%2F..%2Fglade.db", "chat-1/..%2F..%2Fglade.db", "..%2F/glade.db", "chat-1/.hidden", "%2E%2E/glade.db", "chat-1/%E0%A4%A"]) {
      // 400 (malformed ref), or 404 when the URL itself resolved the dots away.
      expect([400, 404], bad).toContain((await call("GET", `/api/blobs/${bad}`)).status);
    }

    expect((await call("GET", "/api/blobs/..%2F..%2Fglade.db")).status).toBe(400);

    // A legacy shared file (until the migration moved it) is still served by hash.
    const hash = createHash("sha256").update(png).digest("hex");
    mkdirSync(`${store.blobs.legacyDir}/${hash.slice(0, 2)}`, { recursive: true });
    writeFileSync(`${store.blobs.legacyDir}/${hash.slice(0, 2)}/${hash}.png`, png);
    expect((await call("GET", `/api/blobs/${hash}`)).status).toBe(200);
    expect((await call("GET", `/api/blobs/${"a".repeat(64)}`)).status).toBe(404);

    const token = await pairDevice();
    expect((await remote("GET", path)).status).toBe(401);
    expect((await remote("GET", path, { token: "not-a-token" })).status).toBe(401);
    const paired = await remote("GET", path, { token });
    expect(paired.status).toBe(200);
    expect(Buffer.from(await paired.arrayBuffer()).equals(png)).toBe(true);
  });
});

describe("live runs store and push references (I-157)", () => {
  it("a tool result image is a blob ref in the store, the live stream and a replay", async () => {
    const { store, service, call } = start();
    const created = await service.createWorkspace({ projectId: null });
    const sid = created.session.session.id;
    const socket = new TestSocket();
    const client = service.sync.connect(socket);
    await client.subscribeSession(sid);
    service.sync.tick();

    await service.prompt(sid, { text: "screenshot" });
    await until(() => Object.values(store.loadTranscript(sid).toolResults).some((r) => r.images?.length) && !service.listSessions().find((s) => s.id === sid)?.running, 4000);
    service.sync.tick();

    const stored = store.loadTranscript(sid);
    const image = Object.values(stored.toolResults).find((r) => r.images?.length)!.images![0]!;
    expect(image).toMatchObject({ type: "image", mimeType: "image/png", width: 320, height: 200 });
    expect(image.data).toBeUndefined();
    expect(image.blob!.startsWith(`${sid}/`)).toBe(true);
    expect(store.blobs.find(image.blob!)).not.toBeNull();

    // Nothing pushed or logged carries the bytes.
    expect(JSON.stringify(socket.sent)).not.toMatch(/"data":"iVBOR/);
    const logged = store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE payload_json LIKE '%iVBOR%'").get() as { n: number };
    expect(logged.n).toBe(0);
    // The client's view built from the stream matches the store, refs included.
    let view: Transcript = emptyTranscript();
    for (const m of socket.sent) {
      if (m.type === "snapshot" && m.scope === "session") view = { messages: m.page.messages, toolResults: m.page.toolResults };
      if (m.type === "session_event" && m.sessionId === sid) view = applyAgentEvent(view, m.event);
    }
    expect(Object.values(view.toolResults).find((r) => r.images?.length)!.images![0]!.blob).toBe(image.blob);

    // A fresh snapshot (another device opening the chat) has the ref, and the blob is servable.
    const again = new TestSocket();
    await service.sync.connect(again).subscribeSession(sid);
    service.sync.tick();
    const snap = again.sent.find((m) => m.type === "snapshot" && m.scope === "session") as Extract<ServerMessage, { type: "snapshot"; scope: "session" }>;
    expect(JSON.stringify(snap.page)).toContain(image.blob!);
    expect((await call("GET", `/api/blobs/${blobUrlPath(image.blob)}`)).status).toBe(200);
    client.dispose();
  });

  it("the harness gets real data for prompt images, sent inline or by reference; the transcript keeps a ref", async () => {
    const { store, harness, service } = start();
    const created = await service.createWorkspace({ projectId: null });
    const sid = created.session.session.id;
    const png = fakePng(4, 16, 16).toString("base64");

    await service.prompt(sid, { text: "look", images: [{ mimeType: "image/png", data: png }] });
    await until(() => store.loadTranscript(sid).messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("You said: look")), 4000);
    const session = [...harness.openSessions][0]!;
    expect(session.prompts[0]!.images).toEqual([{ mimeType: "image/png", data: png }]);
    const user = store.loadTranscript(sid).messages.find((m) => m.role === "user")!;
    const block = (user as Extract<typeof user, { role: "user" }>).content.find((b) => b.type === "image")!;
    expect(block).toMatchObject({ type: "image", blob: expect.stringMatching(new RegExp(`^${sid}/`)) });
    expect("data" in block).toBe(false);

    // Re-sending that image by reference: the harness still receives the bytes.
    await service.prompt(sid, { text: "again", images: [{ mimeType: "image/png", data: "", blob: (block as { blob: string }).blob }] });
    await until(() => session.prompts.length === 2);
    expect(session.prompts[1]!.images).toEqual([{ mimeType: "image/png", data: png }]);
    await expect(service.prompt(sid, { text: "gone", images: [{ mimeType: "image/png", data: "", blob: `sha256:${"b".repeat(64)}` }] })).rejects.toThrow(/no longer available/);
    await expect(service.prompt(sid, { text: "gone", images: [{ mimeType: "image/png", data: "", blob: `${sid}/0000000000000000` }] })).rejects.toThrow(/no longer available/);

    // Another chat sending that image by reference gets its own copy (no sharing).
    const other = (await service.createWorkspace({ projectId: null })).session.session.id;
    await service.prompt(other, { text: "look", images: [{ mimeType: "image/png", data: "", blob: (block as { blob: string }).blob }] });
    await until(() => store.loadTranscript(other).messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("You said: look")), 4000);
    expect(JSON.stringify(store.loadTranscript(other).messages)).toMatch(new RegExp(`"blob":"${other}/`));
    expect(existsSync(`${store.blobs.dir}/${other}`)).toBe(true);
    expect(existsSync(`${store.blobs.dir}/${sid}`)).toBe(true);
  });
});

describe("deleting chats deletes their images (I-163)", () => {
  const screenshot = async (service: AppService, store: Store, sid: string) => {
    await service.prompt(sid, { text: "screenshot" });
    await until(() => Object.values(store.loadTranscript(sid).toolResults).some((r) => r.images?.length) && !service.listSessions().find((s) => s.id === sid)?.running, 4000);
    expect(existsSync(`${store.blobs.dir}/${sid}`)).toBe(true);
  };

  it("closing a tab, closing a sub-agent, and deleting a project remove the folders", async () => {
    const { store, service } = start();
    service.setServerUrl("http://127.0.0.1:4999");
    const dir = mkdtempSync(join(tmpdir(), "glade-blobs-project-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const project = service.createProject({ path: dir });
    const created = await service.createWorkspace({ projectId: project.id });
    const main = created.session.session.id;
    await screenshot(service, store, main);

    // A second tab: closing it removes its folder, the first one's stays.
    const tab = (await service.createSession(created.workspace.id, {})).session.id;
    await screenshot(service, store, tab);
    await service.deleteSession(tab);
    expect(existsSync(`${store.blobs.dir}/${tab}`)).toBe(false);
    expect(existsSync(`${store.blobs.dir}/${main}`)).toBe(true);

    // A sub-agent's images go to its own folder, and go when it's closed.
    const { agent } = await service.spawnAgent(main, { name: "scout", task: "look" });
    await until(() => !service.listSessions().find((s) => s.id === agent.sessionId)?.running, 4000);
    await screenshot(service, store, agent.sessionId);
    expect(JSON.stringify(store.loadTranscript(agent.sessionId).toolResults)).toContain(`"blob":"${agent.sessionId}/`);
    expect((await service.closeAgent(main, "scout")).closed).toBe(true);
    await until(() => !existsSync(`${store.blobs.dir}/${agent.sessionId}`));

    // Deleting the project deletes its chats' folders.
    await service.deleteProject(project.id);
    expect(existsSync(`${store.blobs.dir}/${main}`)).toBe(false);
  });
});
