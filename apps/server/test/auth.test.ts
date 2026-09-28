/**
 * I-125/I-126: who is the local owner, the remote switch, device tokens, WebSocket tickets,
 * pairing (invite → pair → Allow/Deny), rate limits, host-only routes and the audit log.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { AuditAction, PairingInvite, PairResponse, ServerMessage } from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { createApp } from "../src/http/app.js";
import { hasProxyHeaders, isLoopbackAddress, isOwnOrigin } from "../src/http/security.js";
import { AppService } from "../src/services/app-service.js";
import { AuthService, CLOSE_REMOTE_DISABLED, CLOSE_REVOKED, MAX_CODE_ATTEMPTS } from "../src/services/auth/auth-service.js";
import { normalizePairingCode } from "../src/services/auth/secrets.js";
import { Store } from "../src/store/store.js";
import { until } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const DAY = 24 * 60 * 60 * 1000;
const HOST = "127.0.0.1:4317";
/** Another Glade's web view: a loopback origin that isn't this server's. */
const OTHER = "http://127.0.0.1:4400";

function start(opts: { addresses?: string[]; pairTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "glade-auth-"));
  const store = new Store(join(dir, "data"), 0);
  const service = new AppService({ store, harnesses: new HarnessRegistry([new FakeHarness()]), scratchDir: join(dir, "scratch"), sync: { batchMs: 10_000 } });
  const clock = { offset: 0 };
  const auth = new AuthService({
    db: store.db,
    environmentId: service.environment.id,
    environmentName: () => "Test Host",
    addresses: () => opts.addresses ?? ["http://127.0.0.1:4317"],
    now: () => Date.now() + clock.offset,
    watchMs: 0,
    pairTimeoutMs: opts.pairTimeoutMs ?? 5000,
    pairPollMs: 5,
  });
  const { app, injectWebSocket } = createApp({ service, auth, ownPorts: () => [4317, 5317] });
  cleanups.push(async () => {
    auth.dispose();
    await service.dispose();
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  type Opts = { body?: unknown; headers?: Record<string, string>; peer?: string; token?: string };
  const call = (method: string, path: string, o: Opts = {}) =>
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
      { incoming: { socket: { remoteAddress: o.peer ?? "127.0.0.1" } } },
    );
  /** The host itself (loopback, no Origin). */
  const local = (method: string, path: string, body?: unknown) => call(method, path, { body });
  /** A remote client (another app's web view). `from` = its address (X-Forwarded-For, like a proxy). */
  const remote = (method: string, path: string, o: { body?: unknown; token?: string; from?: string } = {}) =>
    call(method, path, { body: o.body, token: o.token, headers: { origin: OTHER, ...(o.from ? { "x-forwarded-for": o.from } : {}) } });

  const enable = async () => expect((await local("PATCH", "/api/auth/remote", { enabled: true })).status).toBe(200);
  const invite = async () => (await (await local("POST", "/api/auth/invites")).json()) as PairingInvite;
  const grantOf = (inv: PairingInvite) => new URL(inv.link.replace("glade://", "http://x/")).searchParams.get("g")!;
  /** Pair from a remote client; the host answers `answer` once the request is pending. */
  const pair = async (grant: string, answer: boolean | null = true, from?: string): Promise<{ status: number; body: PairResponse & { code?: string } }> => {
    const res = remote("POST", "/api/auth/pair", { body: { grant, deviceName: "Laptop", deviceKind: "mac" }, from });
    if (answer !== null) {
      const answered = (async () => {
        for (let i = 0; i < 400; i++) {
          const list = (await (await local("GET", "/api/auth/pending")).json()) as { id: string }[];
          if (list.length) return void (await local("POST", `/api/auth/pending/${list[0]!.id}`, { allow: answer }));
          await new Promise((r) => setTimeout(r, 5));
        }
      })();
      const r = await res;
      await answered;
      return { status: r.status, body: (await r.json()) as PairResponse & { code?: string } };
    }
    const r = await res;
    return { status: r.status, body: (await r.json()) as PairResponse & { code?: string } };
  };
  const paired = async () => {
    await enable();
    const r = await pair(grantOf(await invite()));
    if (r.body.status !== "paired") throw new Error(`not paired: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const audit = async () => ((await (await local("GET", "/api/auth/audit?limit=100")).json()) as { action: AuditAction; detail: string | null }[]).map((a) => a.action);

  return { store, service, auth, app, injectWebSocket, clock, call, local, remote, enable, invite, grantOf, pair, paired, audit };
}

describe("request classification", () => {
  it("helpers", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("100.64.0.2")).toBe(false);
    expect(isOwnOrigin("http://localhost:4317", [4317])).toBe(true);
    expect(isOwnOrigin("http://[::1]:4317", [4317])).toBe(true);
    expect(isOwnOrigin("http://127.0.0.1:4318", [4317])).toBe(false);
    expect(isOwnOrigin("tauri://localhost", [4317])).toBe(false);
    expect(isOwnOrigin("null", [4317])).toBe(false);
    expect(isOwnOrigin("http://localhost.evil.com:4317", [4317])).toBe(false);
    expect(hasProxyHeaders(new Headers({ "X-Forwarded-Proto": "https" }))).toBe(true);
    expect(hasProxyHeaders(new Headers({ "Tailscale-User-Login": "a@b" }))).toBe(true);
    expect(hasProxyHeaders(new Headers({ Forwarded: "for=1.2.3.4" }))).toBe(true);
    expect(hasProxyHeaders(new Headers({ Origin: "x" }))).toBe(false);
  });

  it("local owner: loopback peer and Host, no proxy headers, own or no Origin", async () => {
    const t = start();
    const status = async (o: Parameters<typeof t.call>[2]) => (await t.call("GET", "/api/auth/remote", o)).status;
    expect(await status({})).toBe(200);
    expect(await status({ peer: "::1" })).toBe(200);
    expect(await status({ peer: "::ffff:127.0.0.1" })).toBe(200);
    expect(await status({ headers: { origin: "http://127.0.0.1:4317" } })).toBe(200);
    expect(await status({ headers: { origin: "http://localhost:5317" } })).toBe(200); // web dev server
    // The Vite proxy keeps the browser's Host: its origin matches the Host's port.
    expect(await status({ headers: { host: "127.0.0.1:5999", origin: "http://127.0.0.1:5999" } })).toBe(200);

    // Remote (refused: remote access is off; local-only anyway).
    const remotes: { headers?: Record<string, string>; peer?: string }[] = [
      { headers: { origin: OTHER } },
      { headers: { origin: "https://evil.com" } },
      { headers: { origin: "null" } },
      { headers: { origin: "tauri://localhost" } },
      { headers: { "x-forwarded-for": "100.64.0.2" } },
      { headers: { forwarded: "for=100.64.0.2" } },
      { headers: { "tailscale-user-login": "jason@example.com" } },
      { peer: "192.168.1.20" },
    ];
    for (const o of remotes) {
      const res = await t.call("GET", "/api/auth/remote", o);
      expect(res.status, JSON.stringify(o)).toBe(403);
      expect(await res.json()).toMatchObject({ code: "remote_disabled" });
    }
    // Auth errors are readable cross-origin.
    const res = await t.call("GET", "/api/projects", { headers: { origin: OTHER } });
    expect(res.headers.get("access-control-allow-origin")).toBe(OTHER);
  });

  it("Host allow-list: loopback plus the host's addresses", async () => {
    const t = start({ addresses: ["http://127.0.0.1:4317", "https://mac.tail1234.ts.net"] });
    for (const host of ["evil.com", "evil.com:4317", "127.0.0.1.evil.com", "user@localhost"]) {
      expect((await t.call("GET", "/api/projects", { headers: { host } })).status, host).toBe(403);
      expect(await (await t.call("GET", "/api/projects", { headers: { host } })).json()).toEqual({ error: "Forbidden host" });
    }
    // A configured name passes the Host check but is never local (remote access is off here).
    const res = await t.call("GET", "/api/projects", { headers: { host: "mac.tail1234.ts.net" } });
    expect(await res.json()).toMatchObject({ code: "remote_disabled" });
  });

  it("answers preflights for any origin without exposing data", async () => {
    const t = start();
    for (const origin of [OTHER, "https://evil.com", "tauri://localhost"]) {
      const res = await t.call("OPTIONS", "/api/projects", { headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "authorization" } });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
      expect(res.headers.get("access-control-allow-credentials")).toBeNull();
      expect(await res.text()).toBe("");
    }
  });
});

describe("device tokens", () => {
  it("remote clients need remote access on and a valid, unrevoked, recently used token", async () => {
    const t = start();
    const { token, device, environmentId } = await t.paired();
    expect(environmentId).toBe(t.service.environment.id);
    expect(device).toMatchObject({ name: "Laptop", kind: "mac", scopes: ["full"], connected: false });

    // Before pairing, a client may check the host's identity (nothing more).
    const identity = await t.remote("GET", "/api/environment");
    expect(identity.status).toBe(200);
    expect(await identity.json()).toEqual({ id: t.service.environment.id, name: expect.any(String), version: expect.any(String), protocol: 2 });
    expect(identity.headers.get("access-control-allow-origin")).toBe(OTHER);
    expect(await (await t.remote("GET", "/api/environment", { token })).json()).toHaveProperty("home");
    expect((await t.remote("PATCH", "/api/environment", { body: { name: "x" } })).status).toBe(401);

    const ok = await t.remote("GET", "/api/projects", { token });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(OTHER);
    expect((await t.remote("GET", "/api/projects")).status).toBe(401);
    const bad = await t.remote("GET", "/api/projects", { token: "nope" });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ code: "unauthorized" });
    expect(bad.headers.get("access-control-allow-origin")).toBe(OTHER);

    const me = (await (await t.remote("GET", "/api/auth/me", { token })).json()) as { id: string; lastSeenAt: number };
    expect(me.id).toBe(device.id);
    expect((await t.local("GET", "/api/auth/me")).status).toBe(400);

    // Switch off: refused even with a token; on again: works.
    await t.local("PATCH", "/api/auth/remote", { enabled: false });
    expect(await (await t.remote("GET", "/api/projects", { token })).json()).toMatchObject({ code: "remote_disabled" });
    await t.enable();
    expect((await t.remote("GET", "/api/projects", { token })).status).toBe(200);

    // Unused for 90 days: expired. (Use refreshes it; jump past the idle limit.)
    t.clock.offset = 91 * DAY;
    expect((await t.remote("GET", "/api/projects", { token })).status).toBe(401);
  });

  it("revoked devices get 401; rename and list", async () => {
    const t = start();
    const a = await t.paired();
    const b = await t.pair(t.grantOf(await t.invite()));
    if (b.body.status !== "paired") throw new Error("b not paired");
    const renamed = await t.local("PATCH", `/api/auth/devices/${a.device.id}`, { name: "Work Laptop" });
    expect(await renamed.json()).toMatchObject({ name: "Work Laptop" });
    expect(((await (await t.local("GET", "/api/auth/devices")).json()) as unknown[]).length).toBe(2);

    expect((await t.local("DELETE", `/api/auth/devices/${a.device.id}`)).status).toBe(204);
    expect((await t.remote("GET", "/api/projects", { token: a.token })).status).toBe(401);
    expect((await t.remote("GET", "/api/projects", { token: b.body.token })).status).toBe(200);
    expect((await t.local("DELETE", `/api/auth/devices/${a.device.id}`)).status).toBe(404);
    expect((await t.local("DELETE", "/api/auth/devices")).status).toBe(204);
    expect((await t.remote("GET", "/api/projects", { token: b.body.token })).status).toBe(401);
    expect(await (await t.local("GET", "/api/auth/devices")).json()).toEqual([]);
    const actions = await t.audit();
    expect(actions).toEqual(expect.arrayContaining(["remote_enabled", "invite_created", "pair_requested", "pair_allowed", "device_renamed", "device_revoked", "auth_failed"]));
  });

  it("remote clients can't use host-only routes, even with a token", async () => {
    const t = start();
    const { token } = await t.paired();
    const session = await t.service.createWorkspace({ projectId: null });
    const routes: [string, string, unknown?][] = [
      ["GET", "/api/auth/remote"],
      ["PATCH", "/api/auth/remote", { enabled: false }],
      ["POST", "/api/auth/invites"],
      ["DELETE", "/api/auth/invites/current"],
      ["GET", "/api/auth/pending"],
      ["POST", "/api/auth/pending/x", { allow: true }],
      ["GET", "/api/auth/devices"],
      ["DELETE", "/api/auth/devices"],
      ["GET", "/api/auth/audit"],
      ["POST", "/api/projects/x/open", { app: "finder" }],
      ["POST", `/api/workspaces/${session.workspace.id}/open`, { app: "finder" }],
      ["POST", "/api/fs/pick-folder"],
      ["POST", "/api/fs/reveal", { path: "/tmp" }],
      ["POST", `/api/sessions/${session.session.session.id}/export`, { reveal: true }],
      ["GET", "/api/agents/list"],
    ];
    for (const [method, path, body] of routes) {
      const res = await t.remote(method, path, { token, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json(), `${method} ${path}`).toMatchObject({ code: "local_only" });
    }
    // Still on: remote access wasn't switched off by the refused PATCH.
    expect((await t.local("GET", "/api/auth/remote")).status).toBe(200);
    expect(await (await t.local("GET", "/api/auth/remote")).json()).toMatchObject({ enabled: true });
    // Ordinary things work, including exports as downloads.
    expect((await t.remote("GET", `/api/sessions/${session.session.session.id}/export/download`, { token })).status).toBe(200);
  });
});

describe("pairing", () => {
  it("invite link, allow, deny, one use, replacement", async () => {
    const t = start();
    expect((await t.local("POST", "/api/auth/invites")).status).toBe(409); // remote access off
    await t.enable();
    const inv = await t.invite();
    expect(inv.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(inv.expiresAt - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    const link = new URL(inv.link.replace("glade://", "http://x/"));
    expect(inv.link.startsWith("glade://pair?")).toBe(true);
    expect(link.searchParams.get("v")).toBe("1");
    expect(link.searchParams.get("e")).toBe(t.service.environment.id);
    expect(link.searchParams.get("n")).toBe("Test Host");
    expect(link.searchParams.getAll("u")).toEqual(["http://127.0.0.1:4317"]);
    expect(t.grantOf(inv)).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // Denied: the invite is used up.
    expect((await t.pair(t.grantOf(inv), false)).body).toEqual({ status: "denied" });
    expect((await t.pair(t.grantOf(inv), null)).body).toEqual({ status: "expired" });

    // The short code works too (any case, with or without the dash).
    const inv2 = await t.invite();
    const r = await t.pair(inv2.code.toLowerCase().replace("-", ""), true);
    expect(r.body.status).toBe("paired");

    // A new invite replaces the old one.
    const old = await t.invite();
    await t.invite();
    expect((await t.pair(t.grantOf(old), null)).body).toEqual({ status: "expired" });
    // Cancelled invites too.
    const cancelled = await t.invite();
    expect((await t.local("DELETE", "/api/auth/invites/current")).status).toBe(204);
    expect((await t.pair(t.grantOf(cancelled), null, "10.0.0.9")).body).toEqual({ status: "expired" });
    // Unknown grants: 400.
    const unknown = await t.pair("x".repeat(22), null, "10.0.0.8");
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("invalid_grant");
  });

  it("invites expire after 5 minutes; unanswered pairings time out", async () => {
    const t = start({ pairTimeoutMs: 60 });
    await t.enable();
    const inv = await t.invite();
    t.clock.offset = 5 * 60 * 1000 + 1;
    expect((await t.pair(t.grantOf(inv), null)).body).toEqual({ status: "expired" });
    t.clock.offset = 0;
    const inv2 = await t.invite();
    expect((await t.pair(t.grantOf(inv2), null)).body).toEqual({ status: "timeout" });
    expect(await (await t.local("GET", "/api/auth/pending")).json()).toEqual([]);
    expect((await t.local("POST", "/api/auth/pending/nope", { allow: true })).status).toBe(404);
  });

  it("turning remote access off fails pairings in flight", async () => {
    const t = start();
    await t.enable();
    const inv = await t.invite();
    const res = t.remote("POST", "/api/auth/pair", { body: { grant: t.grantOf(inv), deviceName: "X", deviceKind: "phone" } });
    await until(() => t.auth.listPending().length === 1);
    await t.local("PATCH", "/api/auth/remote", { enabled: false });
    expect(await (await res).json()).toEqual({ status: "expired" });
  });

  it("wrong codes: 5 and the invite dies; rate limits per address and overall", async () => {
    const t = start();
    await t.enable();
    const inv = await t.invite();
    const right = normalizePairingCode(inv.code)!;
    const wrong = (right[0] === "0" ? "1" : "0") + right.slice(1);
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      const r = await t.pair(wrong, null, `10.0.1.${i}`);
      expect(r.status).toBe(400);
    }
    expect((await t.pair(inv.code, null, "10.0.2.1")).body).toEqual({ status: "expired" });
    expect(await t.audit()).toContain("pair_failed");

    // Per address: 5 a minute.
    for (let i = 0; i < 5; i++) expect((await t.pair("y".repeat(22), null, "10.0.3.1")).status).toBe(400);
    const limited = await t.pair("y".repeat(22), null, "10.0.3.1");
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    // Overall: 30 a minute.
    let status = 0;
    for (let i = 0; i < 30 && status !== 429; i++) status = (await t.pair("y".repeat(22), null, `10.0.4.${i}`)).status;
    expect(status).toBe(429);
    // A minute later it's fine again.
    t.clock.offset = 61_000;
    expect((await t.pair("y".repeat(22), null, "10.0.3.1")).status).toBe(400);
  });

  it("pushes pairing_pending to local sockets only", async () => {
    const t = start();
    await t.enable();
    const localMsgs: ServerMessage[] = [];
    const detach = t.auth.attachSocket({ kind: "local" }, { send: (m) => localMsgs.push(m), close: () => {} });
    cleanups.push(detach);
    const inv = await t.invite();
    const done = t.pair(t.grantOf(inv), true);
    await done;
    const pushes = localMsgs.filter((m): m is Extract<ServerMessage, { type: "pairing_pending" }> => m.type === "pairing_pending");
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    expect(pushes[0]!.pending).toMatchObject([{ deviceName: "Laptop", deviceKind: "mac", remoteAddress: "127.0.0.1" }]);
    expect(pushes.at(-1)!.pending).toEqual([]);
  });
});

describe("WebSocket tickets", () => {
  async function listen(t: ReturnType<typeof start>) {
    const server = serve({ fetch: t.app.fetch, hostname: "127.0.0.1", port: 0 });
    t.injectWebSocket(server);
    await new Promise<void>((r) => server.once("listening", () => r()));
    cleanups.push(() => server.close());
    return (server.address() as AddressInfo).port;
  }
  const refused = (url: string) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(url, { origin: OTHER });
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("open", () => resolve(101));
      ws.once("error", () => resolve(-1));
    });
  const open = async (url: string) => {
    const ws = new WebSocket(url, { origin: OTHER });
    const received: ServerMessage[] = [];
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    ws.on("message", (d) => received.push(JSON.parse(String(d)) as ServerMessage));
    await new Promise((r, j) => ws.once("open", r).once("error", j));
    return { ws, received, closed };
  };
  const ticket = async (t: ReturnType<typeof start>, token: string) =>
    ((await (await t.remote("POST", "/api/auth/ws-ticket", { token })).json()) as { ticket: string; expiresAt: number }).ticket;

  it("single use, 60 s, and revoking closes the device's sockets", async () => {
    const t = start();
    const port = await listen(t);
    const { token, device } = await t.paired();
    const base = `ws://127.0.0.1:${port}/ws`;
    expect(await refused(base)).toBe(401);
    expect(await refused(`${base}?ticket=nope`)).toBe(401);

    const tk = await ticket(t, token);
    const s = await open(`${base}?ticket=${tk}`);
    await until(() => s.received.length > 0);
    expect(s.received[0]).toMatchObject({ type: "hello" });
    expect(await refused(`${base}?ticket=${tk}`)).toBe(401); // used
    expect(((await (await t.local("GET", "/api/auth/devices")).json()) as { connected: boolean }[])[0]!.connected).toBe(true);

    const late = await ticket(t, token);
    t.clock.offset = 61_000;
    expect(await refused(`${base}?ticket=${late}`)).toBe(401);
    t.clock.offset = 0;

    await t.local("DELETE", `/api/auth/devices/${device.id}`);
    expect(await s.closed).toBe(CLOSE_REVOKED);
    expect((await t.remote("POST", "/api/auth/ws-ticket", { token })).status).toBe(401);
    // The host's own sockets need no ticket.
    const own = new WebSocket(base, { origin: "http://127.0.0.1:5317" });
    await new Promise((r, j) => own.once("open", r).once("error", j));
    own.close();
  });

  it("turning remote access off (here or on another server) closes remote sockets", async () => {
    const t = start();
    const port = await listen(t);
    const { token } = await t.paired();
    const base = `ws://127.0.0.1:${port}/ws`;
    const a = await open(`${base}?ticket=${await ticket(t, token)}`);
    await t.local("PATCH", "/api/auth/remote", { enabled: false });
    expect(await a.closed).toBe(CLOSE_REMOTE_DISABLED);
    expect(await refused(`${base}?ticket=x`)).toBe(403);

    // Another server on the data folder revokes: our watch notices.
    await t.enable();
    const b = await open(`${base}?ticket=${await ticket(t, token)}`);
    const other = new AuthService({ db: t.store.db, environmentId: "x", environmentName: () => "x", addresses: () => [], watchMs: 0 });
    other.revokeAll();
    t.auth.watch();
    expect(await b.closed).toBe(CLOSE_REVOKED);
  });
});
