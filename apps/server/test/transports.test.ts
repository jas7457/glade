/**
 * I-127: the Tailscale transport. CLI discovery, status parsing from fixtures (signed out, HTTPS
 * off, serving, Funnel, someone else's handler), the serve commands issued through a fake
 * runner (never the real CLI), which server manages serve, addresses / Host allow-list, and
 * peer discovery with a mocked fetch.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteAccessState } from "@glade/protocol";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { createApp } from "../src/http/app.js";
import { AppService } from "../src/services/app-service.js";
import { AuthService } from "../src/services/auth/auth-service.js";
import { lastServedPort, managesTransport, RemoteTransport } from "../src/services/transports/manager.js";
import {
  evaluateTailscale,
  findTailscaleCli,
  loopbackProxyPort,
  parseServeConfig,
  parseTailscaleStatus,
  TailscaleTransport,
  TAILSCALE_APP_BINARY,
} from "../src/services/transports/tailscale.js";
import type { CommandRunner } from "../src/services/transports/transport.js";
import { Store } from "../src/store/store.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/tailscale/${name}`, import.meta.url), "utf8"));
const DNS = "studio.tail1234.ts.net";
const CLI = "/fake/tailscale";

/** Tests never reach the network. */
const noFetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A fake `tailscale` CLI: answers status/serve status from state and applies serve changes to it. */
function fakeCli(opts: { status?: unknown; serve?: Record<string, unknown>; fail?: boolean } = {}) {
  const state = { status: opts.status ?? fixture("status-running.json"), serve: structuredClone(opts.serve ?? {}) as Record<string, unknown> };
  const calls: string[][] = [];
  const runner: CommandRunner = async (file, args) => {
    expect(file).toBe(CLI);
    calls.push(args);
    const key = args.join(" ");
    if (key === "status --json") return { code: 0, stdout: JSON.stringify(state.status), stderr: "" };
    if (key === "serve status --json") return { code: 0, stdout: JSON.stringify(state.serve), stderr: "" };
    if (opts.fail) return { code: 1, stdout: "", stderr: "error: boom\n" };
    const bg = args.join(" ").match(/^serve --bg --https=443 (http:\/\/127\.0\.0\.1:\d+)$/);
    if (bg) {
      state.serve = { TCP: { "443": { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: bg[1] } } } } };
      return { code: 0, stdout: "Available within your tailnet", stderr: "" };
    }
    if (key === "serve --https=443 --set-path=/ off") {
      state.serve = {};
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected tailscale ${key}`);
  };
  /** Only the commands that change serve. */
  const changes = () => calls.filter((a) => !(a.join(" ") === "status --json" || a.join(" ") === "serve status --json")).map((a) => a.join(" "));
  return { state, calls, runner, changes };
}

function transport(cli: ReturnType<typeof fakeCli>, o: { gladePorts?: number[]; managed?: boolean; fetch?: typeof fetch } = {}) {
  return new TailscaleTransport({
    runner: cli.runner,
    env: { GLADE_TAILSCALE_CLI: CLI },
    exists: (p) => p === CLI,
    gladePorts: () => o.gladePorts ?? [4327, 4317],
    managed: o.managed ?? true,
    fetch: o.fetch,
  });
}

describe("findTailscaleCli", () => {
  it("prefers the override, then the standard paths, then the app binary with TAILSCALE_BE_CLI", () => {
    const has = (...paths: string[]) => (p: string) => paths.includes(p);
    expect(findTailscaleCli({ GLADE_TAILSCALE_CLI: "/x/ts" }, has("/x/ts", "/usr/local/bin/tailscale"))).toEqual({ cli: { path: "/x/ts" } });
    expect(findTailscaleCli({ GLADE_TAILSCALE_CLI: "/x/ts" }, has("/usr/local/bin/tailscale"))).toMatchObject({ cli: null, problem: "cli_not_found" });
    expect(findTailscaleCli({}, has("/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"))).toEqual({ cli: { path: "/usr/local/bin/tailscale" } });
    expect(findTailscaleCli({}, has("/opt/homebrew/bin/tailscale"))).toEqual({ cli: { path: "/opt/homebrew/bin/tailscale" } });
    expect(findTailscaleCli({}, has(TAILSCALE_APP_BINARY))).toEqual({ cli: { path: TAILSCALE_APP_BINARY, env: { TAILSCALE_BE_CLI: "1" } } });
    expect(findTailscaleCli({}, has())).toMatchObject({ cli: null, problem: "not_installed" });
  });
});

describe("parsing", () => {
  it("reads status --json defensively", () => {
    const s = parseTailscaleStatus(fixture("status-running.json"));
    expect(s).toMatchObject({ backendState: "Running", ips: ["100.100.1.1", "fd7a:115c:a1e0::1"], certDomains: [DNS] });
    expect(s.self).toMatchObject({ dnsName: DNS, os: "macOS" });
    expect(s.peers.map((p) => [p.dnsName, p.online])).toEqual([
      ["macbook-air.tail1234.ts.net", true],
      ["iphone.tail1234.ts.net", true],
      ["old-pc.tail1234.ts.net", false],
    ]);
    expect(parseTailscaleStatus(null)).toMatchObject({ backendState: "Unknown", self: null, peers: [], certDomains: [] });
    expect(parseTailscaleStatus({ BackendState: 5, Self: "x", Peer: [1], CertDomains: "a" })).toMatchObject({ backendState: "Unknown", self: null, peers: [] });
  });

  it("reads serve status for <machine>:443 (foreground sessions too) and loopback targets", () => {
    expect(parseServeConfig(fixture("serve-glade.json"), DNS)).toEqual({ root: { proxy: "http://127.0.0.1:4327" }, funnel: false, tcpForward: false });
    expect(parseServeConfig(fixture("serve-funnel.json"), DNS).funnel).toBe(true);
    expect(parseServeConfig({}, DNS)).toEqual({ funnel: false, tcpForward: false });
    expect(parseServeConfig({ Foreground: { s1: { Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } } } }, DNS).root).toEqual({ proxy: "http://127.0.0.1:3000" });
    expect(parseServeConfig({ TCP: { "443": { TCPForward: "127.0.0.1:22" } } }, DNS).tcpForward).toBe(true);
    expect(loopbackProxyPort("http://127.0.0.1:4327")).toBe(4327);
    expect(loopbackProxyPort("http://localhost:4327/")).toBe(4327);
    expect(loopbackProxyPort("http://127.0.0.1:4327/sub")).toBeNull();
    expect(loopbackProxyPort("https://127.0.0.1:4327")).toBeNull();
    expect(loopbackProxyPort("http://10.0.0.2:4327")).toBeNull();
  });

  it("evaluates each situation", () => {
    const running = parseTailscaleStatus(fixture("status-running.json"));
    const ev = (status: unknown, serve: unknown, gladePorts = [4327]) =>
      evaluateTailscale({ state: parseTailscaleStatus(status), serve: serve === null ? null : parseServeConfig(serve, DNS), gladePorts, managed: true }).status;
    expect(ev(fixture("status-signed-out.json"), null)).toMatchObject({ available: false, problem: "signed_out", https: false });
    expect(ev({ ...(running as object), BackendState: "Stopped" }, null)).toMatchObject({ available: false, problem: "stopped" });
    expect(ev(fixture("status-https-off.json"), {})).toMatchObject({ available: false, problem: "https_off", reason: "HTTPS is off in your tailnet.", dnsName: DNS });
    expect(ev(fixture("status-running.json"), {})).toEqual({ id: "tailscale", available: true, https: true, serving: false, dnsName: DNS, ips: ["100.100.1.1", "fd7a:115c:a1e0::1"], managed: true });
    expect(ev(fixture("status-running.json"), fixture("serve-glade.json"))).toMatchObject({ available: true, serving: true });
    expect(ev(fixture("status-running.json"), fixture("serve-funnel.json"))).toMatchObject({ available: false, problem: "funnel_on", serving: true });
    expect(ev(fixture("status-running.json"), fixture("serve-foreign.json"))).toMatchObject({ available: false, problem: "port_in_use", reason: expect.stringContaining("http://127.0.0.1:3000") });
    // A handler on a port that isn't Glade's is someone else's.
    expect(ev(fixture("status-running.json"), fixture("serve-glade.json"), [4317])).toMatchObject({ available: false, problem: "port_in_use" });
  });
});

describe("TailscaleTransport commands", () => {
  it("enable runs serve --bg --https=443 to this port; disable removes only the / handler", async () => {
    const cli = fakeCli();
    const t = transport(cli);
    expect(await t.enable(4327)).toMatchObject({ serving: true });
    expect(await t.enable(4327)).toMatchObject({ serving: true }); // already there: no command
    expect(await t.disable()).toMatchObject({ serving: false });
    expect(await t.disable()).toMatchObject({ serving: false }); // nothing of ours: no command
    expect(cli.changes()).toEqual(["serve --bg --https=443 http://127.0.0.1:4327", "serve --https=443 --set-path=/ off"]);
    expect(cli.calls.flat()).not.toContain("funnel");
  });

  it("refuses with HTTPS off, a Funnel or someone else's handler, and never touches them", async () => {
    for (const [status, serve, text] of [
      ["status-https-off.json", {}, /HTTPS is off/],
      ["status-signed-out.json", {}, /signed out/],
      ["status-running.json", fixture("serve-funnel.json"), /Funnel/],
      ["status-running.json", fixture("serve-foreign.json"), /already used/],
    ] as const) {
      const cli = fakeCli({ status: fixture(status), serve: serve as Record<string, unknown> });
      await expect(transport(cli, { gladePorts: [4317] }).enable(4317)).rejects.toThrow(text);
      await transport(cli, { gladePorts: [4317] }).disable();
      expect(cli.changes()).toEqual([]);
    }
  });

  it("reconcile: repoints a stale Glade port, removes Glade's handler when off or behind a Funnel", async () => {
    const stale = fakeCli({ serve: fixture("serve-glade.json") as Record<string, unknown> });
    expect(await transport(stale, { gladePorts: [4327, 4400] }).reconcile(4400, true)).toMatchObject({ serving: true });
    expect(stale.changes()).toEqual(["serve --bg --https=443 http://127.0.0.1:4400"]);

    const same = fakeCli({ serve: fixture("serve-glade.json") as Record<string, unknown> });
    await transport(same).reconcile(4327, true);
    expect(same.changes()).toEqual([]);

    const off = fakeCli({ serve: fixture("serve-glade.json") as Record<string, unknown> });
    expect(await transport(off).reconcile(4327, false)).toMatchObject({ serving: false });
    expect(off.changes()).toEqual(["serve --https=443 --set-path=/ off"]);

    const foreignOff = fakeCli({ serve: fixture("serve-foreign.json") as Record<string, unknown> });
    await transport(foreignOff).reconcile(4327, false);
    expect(foreignOff.changes()).toEqual([]);

    const funnel = fakeCli({ serve: fixture("serve-funnel.json") as Record<string, unknown> });
    expect(await transport(funnel).reconcile(4327, true)).toMatchObject({ available: false, problem: "funnel_on" });
    expect(funnel.changes()).toEqual(["serve --https=443 --set-path=/ off"]);

    const signedOut = fakeCli({ status: fixture("status-signed-out.json") });
    expect(await transport(signedOut).reconcile(4327, true)).toMatchObject({ problem: "signed_out" });
    expect(signedOut.changes()).toEqual([]);
  });

  it("reports a failed serve command", async () => {
    const cli = fakeCli({ fail: true });
    await expect(transport(cli).enable(4327)).rejects.toThrow("Couldn't start Tailscale Serve: error: boom");
  });

  it("reports a CLI that can't run or a daemon that isn't running", async () => {
    const t = (runner: CommandRunner) => new TailscaleTransport({ runner, env: { GLADE_TAILSCALE_CLI: CLI }, exists: () => true, gladePorts: () => [], managed: false });
    expect(await t(async () => Promise.reject(Object.assign(new Error("spawn EACCES"), { code: "EACCES" }))).status()).toMatchObject({ problem: "cli_not_found" });
    expect(await t(async () => ({ code: 1, stdout: "", stderr: "failed to connect to local Tailscale service; is Tailscale running?" })).status()).toMatchObject({ problem: "not_running" });
    expect(await new TailscaleTransport({ env: {}, exists: () => false, gladePorts: () => [], managed: false }).status()).toMatchObject({ problem: "not_installed", managed: false });
  });

  it("identify reads the Tailscale-User-* headers", () => {
    const t = transport(fakeCli());
    expect(t.identify(new Headers({ "Tailscale-User-Login": "a@example.com", "Tailscale-User-Name": "A" }))).toEqual({ login: "a@example.com", name: "A" });
    expect(t.identify(new Headers())).toBeNull();
  });

  it("discover probes online peers' /api/environment", async () => {
    const probed: string[] = [];
    const fakeFetch = (async (url: string) => {
      probed.push(url);
      if (url.startsWith("https://macbook-air.")) return new Response(JSON.stringify({ id: "ENV-AIR", name: "Jason's MacBook Air" }), { status: 200 });
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const found = await transport(fakeCli(), { fetch: fakeFetch }).discover();
    expect(probed.sort()).toEqual(["https://iphone.tail1234.ts.net/api/environment", "https://macbook-air.tail1234.ts.net/api/environment"]);
    expect(found).toEqual([
      { name: "Jason's MacBook Air", address: "https://macbook-air.tail1234.ts.net", environmentId: "ENV-AIR", reachable: true, os: "macOS" },
      { name: "iPhone", address: "https://iphone.tail1234.ts.net", reachable: false, os: "iOS" },
    ]);
  });
});

describe("which server manages serve", () => {
  it("the desktop app by default; others only with GLADE_TAILSCALE_OWNER=1", () => {
    expect(managesTransport({ GLADE_SERVER_KIND: "desktop" })).toBe(true);
    expect(managesTransport({ GLADE_SERVER_KIND: "dev" })).toBe(false);
    expect(managesTransport({ GLADE_SERVER_KIND: "sandbox" })).toBe(false);
    expect(managesTransport({})).toBe(false);
    expect(managesTransport({ GLADE_SERVER_KIND: "dev", GLADE_TAILSCALE_OWNER: "1" })).toBe(true);
    expect(managesTransport({ GLADE_SERVER_KIND: "desktop", GLADE_TAILSCALE_OWNER: "0" })).toBe(false);
  });
});

describe("remote access over the transport (HTTP)", () => {
  function start(o: { managed: boolean; cli?: ReturnType<typeof fakeCli> }) {
    const dir = mkdtempSync(join(tmpdir(), "glade-ts-"));
    const store = new Store(join(dir, "data"), 0);
    const service = new AppService({ store, harnesses: new HarnessRegistry([new FakeHarness()]), scratchDir: join(dir, "scratch"), sync: { batchMs: 10_000 } });
    const cli = o.cli ?? fakeCli();
    let auth!: AuthService;
    const remote = new RemoteTransport({
      transport: transport(cli, { managed: o.managed, gladePorts: [4327], fetch: noFetch }),
      db: store.db,
      managed: o.managed,
      port: () => 4327,
      isEnabled: () => auth.isRemoteEnabled(),
      watchMs: 0,
    });
    auth = new AuthService({
      db: store.db,
      environmentId: service.environment.id,
      environmentName: () => "Studio",
      addresses: () => {
        const via = remote.addresses();
        return via.length ? via : ["http://127.0.0.1:4327"];
      },
      hostnames: () => remote.hostnames(),
      watchMs: 0,
    });
    const { app } = createApp({ service, auth, remote, ownPorts: () => [4327] });
    cleanups.push(async () => {
      remote.dispose();
      auth.dispose();
      await service.dispose();
      store.dispose();
      rmSync(dir, { recursive: true, force: true });
    });
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      app.request(
        path,
        { method, headers: { host: "127.0.0.1:4327", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) },
        { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
      );
    return { store, auth, remote, cli, call };
  }

  it("the managing server turns serve on/off with the switch; addresses, Host allow-list and pairing links follow", async () => {
    const t = start({ managed: true });
    const before = (await (await t.call("GET", "/api/auth/remote")).json()) as RemoteAccessState;
    expect(before).toMatchObject({ enabled: false, addresses: ["http://127.0.0.1:4327"], transport: { available: true, serving: false, https: true, dnsName: DNS, managed: true } });

    const on = (await (await t.call("PATCH", "/api/auth/remote", { enabled: true })).json()) as RemoteAccessState;
    expect(on).toMatchObject({ enabled: true, addresses: [`https://${DNS}`], transport: { serving: true } });
    expect(t.cli.changes()).toEqual(["serve --bg --https=443 http://127.0.0.1:4327"]);
    expect(lastServedPort(t.store.db)).toBe(4327);

    // The tailnet name passes the Host check (a proxied request: remote, needs a token).
    const proxied = await t.call("GET", "/api/projects", undefined, { host: DNS, "x-forwarded-for": "100.100.1.2", "tailscale-user-login": "a@example.com" });
    expect(proxied.status).toBe(401);
    expect((await t.call("GET", "/api/projects", undefined, { host: "evil.example" })).status).toBe(403);

    const invite = (await (await t.call("POST", "/api/auth/invites")).json()) as { link: string };
    expect(new URL(invite.link.replace("glade://", "http://x/")).searchParams.getAll("u")).toEqual([`https://${DNS}`]);

    const off = (await (await t.call("PATCH", "/api/auth/remote", { enabled: false })).json()) as RemoteAccessState;
    expect(off).toMatchObject({ enabled: false, addresses: ["http://127.0.0.1:4327"], transport: { serving: false } });
    expect(t.cli.changes()).toEqual(["serve --bg --https=443 http://127.0.0.1:4327", "serve --https=443 --set-path=/ off"]);
  });

  it("can't be turned on while the transport isn't available", async () => {
    const t = start({ managed: true, cli: fakeCli({ status: fixture("status-https-off.json") }) });
    const res = await t.call("PATCH", "/api/auth/remote", { enabled: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "transport_unavailable", error: "HTTPS is off in your tailnet." });
    expect(t.auth.isRemoteEnabled()).toBe(false);
    expect(t.cli.changes()).toEqual([]);
  });

  it("a server that doesn't manage serve only flips the switch; the managing one reconciles on its watch", async () => {
    const t = start({ managed: false });
    await t.call("PATCH", "/api/auth/remote", { enabled: true });
    expect(t.auth.isRemoteEnabled()).toBe(true);
    await t.remote.tick();
    expect(t.cli.changes()).toEqual([]);

    // The managing server (same data folder) notices the switch and serves.
    const owner = new RemoteTransport({ transport: transport(t.cli, { fetch: noFetch }), db: t.store.db, managed: true, port: () => 4327, isEnabled: () => t.auth.isRemoteEnabled(), watchMs: 0 });
    owner.start();
    await owner.refresh();
    expect(t.cli.changes()).toEqual(["serve --bg --https=443 http://127.0.0.1:4327"]);
    t.auth.setRemoteEnabled(false);
    await owner.tick();
    expect(t.cli.changes()).toEqual(["serve --bg --https=443 http://127.0.0.1:4327", "serve --https=443 --set-path=/ off"]);
  });

  it("master switch (I-132): off stops hosting and removes serve; on restores the remembered host switch", async () => {
    const t = start({ managed: true });
    await t.call("PATCH", "/api/auth/remote", { enabled: true });
    expect(t.auth.isMasterOn()).toBe(true);
    const off = (await (await t.call("PATCH", "/api/auth/remote", { master: false })).json()) as RemoteAccessState;
    expect(off).toMatchObject({ enabled: false, master: false, transport: { serving: false } });
    expect(t.cli.changes()).toEqual(["serve --bg --https=443 http://127.0.0.1:4327", "serve --https=443 --set-path=/ off"]);
    expect(t.auth.hostPreference()).toBe(true);

    const on = (await (await t.call("PATCH", "/api/auth/remote", { master: true })).json()) as RemoteAccessState;
    expect(on).toMatchObject({ enabled: true, master: true, transport: { serving: true } });
    expect(t.cli.changes()).toHaveLength(3);

    // Host switch off, then master off and on: hosting stays off.
    await t.call("PATCH", "/api/auth/remote", { enabled: false });
    await t.call("PATCH", "/api/auth/remote", { master: false });
    expect(await (await t.call("PATCH", "/api/auth/remote", { master: true })).json()).toMatchObject({ enabled: false, master: true });
    expect((await t.call("PATCH", "/api/auth/remote", { master: "yes" })).status).toBe(400);
  });

  it("master on while Tailscale can't serve: remote access is on, hosting stays off with the reason", async () => {
    const cli = fakeCli();
    const t = start({ managed: true, cli });
    await t.call("PATCH", "/api/auth/remote", { enabled: true });
    await t.call("PATCH", "/api/auth/remote", { master: false });
    cli.state.status = fixture("status-https-off.json");
    const res = await t.call("PATCH", "/api/auth/remote", { master: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, master: true, transport: { error: "HTTPS is off in your tailnet." } });
    expect(t.auth.hostPreference()).toBe(true);
  });

  it("peers lists tailnet machines with their online state (local only, read-only)", async () => {
    const t = start({ managed: false });
    const res = await t.call("GET", "/api/auth/peers");
    expect(await res.json()).toEqual([
      { dnsName: "macbook-air.tail1234.ts.net", name: "MacBook Air", online: true, os: "macOS" },
      { dnsName: "iphone.tail1234.ts.net", name: "iPhone", online: true, os: "iOS" },
      { dnsName: "old-pc.tail1234.ts.net", name: "old-pc", online: false, os: "windows" },
    ]);
    expect(t.cli.calls.map((a) => a.join(" "))).toContain("status --json");
    expect(t.cli.changes()).toEqual([]);
    expect((await t.call("GET", "/api/auth/peers", undefined, { origin: "http://127.0.0.1:9999" })).status).toBe(403);
  });

  it("discover lists tailnet peers (local only)", async () => {
    const t = start({ managed: false });
    const res = await t.call("GET", "/api/auth/discover");
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
    expect((await t.call("GET", "/api/auth/discover", undefined, { origin: "http://127.0.0.1:9999" })).status).toBe(403);
  });
});
