/**
 * I-155: the device offers only agents that are installed and turned on (Settings → Agents);
 * other devices see and use only those; a device's settings are changed on that device only
 * (PATCH /settings from a paired device is 403, reads stay allowed).
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAgentEnabled, type AgentCatalogEntry, type PairingInvite, type PairResponse, type Settings } from "@glade/protocol";
import { AcpHarnessProvider } from "../src/harness/acp/acp-harness.js";
import { acpAgentConfigs, buildAgentCatalog } from "../src/harness/agent-catalog.js";
import { FakeHarness } from "../src/harness/fake/fake-harness.js";
import { HarnessRegistry } from "../src/harness/registry.js";
import { cachedWhich, findExecutable } from "../src/harness/which.js";
import { createApp } from "../src/http/app.js";
import { AppService } from "../src/services/app-service.js";
import { AuthService } from "../src/services/auth/auth-service.js";
import { Store } from "../src/store/store.js";
import { flush } from "./helpers.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "glade-agents-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("detection (PATH lookup, nothing started)", () => {
  it("finds executables on the PATH or by path; caches answers", () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "my-agent"), "#!/bin/sh\n");
    chmodSync(join(bin, "my-agent"), 0o755);
    writeFileSync(join(bin, "not-exec"), "");
    expect(findExecutable("my-agent", bin)).toBe(join(bin, "my-agent"));
    expect(findExecutable("not-exec", bin)).toBeNull();
    expect(findExecutable("missing", bin)).toBeNull();
    expect(findExecutable(join(bin, "my-agent"), "")).toBe(join(bin, "my-agent"));

    let calls = 0;
    const which = cachedWhich(60_000, (c) => (calls++, c === "yes" ? "/bin/yes" : null));
    expect([which("yes"), which("yes"), which("no")]).toEqual([true, true, false]);
    expect(calls).toBe(2);
  });

  it("known ACP agents become harnesses when installed; a user's agent with the same command replaces one", () => {
    const installed = new Set(["claude-code-acp", "gemini"]);
    const which = (c: string) => installed.has(c);
    expect(acpAgentConfigs([], which).map((a) => [a.id, a.command, a.args.join(" ")])).toEqual([
      ["claude-code", "claude-code-acp", ""],
      ["gemini-cli", "gemini", "--experimental-acp"],
    ]);
    const custom = [{ id: "my-gemini", name: "My Gemini", command: "/opt/bin/gemini", args: ["--acp"], env: {} }];
    expect(acpAgentConfigs(custom, which).map((a) => a.id)).toEqual(["my-gemini", "claude-code"]);
  });
});

describe("offered agents", () => {
  function setup(installed: Record<string, boolean> = {}) {
    const dir = tempDir();
    let store = new Store(join(dir, "data"), 0);
    const alpha = new FakeHarness(undefined, 0, { id: "alpha", label: "Alpha" });
    const beta = new FakeHarness(undefined, 0, { id: "beta", label: "Beta" });
    const which = (c: string) => installed[c] ?? false;
    const acp = new AcpHarnessProvider(() => acpAgentConfigs(store.getSettings().harnesses.acp.agents, which), { which });
    const registry = new HarnessRegistry([alpha, beta], {
      preferred: () => store.getSettings().agent.defaultHarness,
      dynamic: () => acp.list(),
      enabled: (id) => isAgentEnabled(store.getSettings(), id),
    });
    const make = () => new AppService({ store, harnesses: registry, scratchDir: join(dir, "scratch"), environment: { machineName: () => "Air" } });
    let service = make();
    cleanups.push(async () => {
      await service.dispose();
      store.dispose();
    });
    /** A restart without disposing the harnesses (their in-memory sessions survive). */
    const restart = async () => {
      for (const h of [alpha, beta]) vi.spyOn(h, "dispose").mockResolvedValueOnce();
      await service.dispose();
      store = new Store(join(dir, "data"), 0);
      service = make();
      return service;
    };
    return { store: () => store, service, registry, alpha, beta, restart };
  }

  it("a turned-off agent isn't listed, can't start new chats or be the default", async () => {
    const { service } = setup();
    expect(service.listHarnesses().map((h) => h.id)).toEqual(["alpha", "beta"]);
    service.updateSettings({ agent: { defaultHarness: "beta" }, agents: { beta: { enabled: false } } });
    expect(service.listHarnesses().map((h) => [h.id, h.isDefault])).toEqual([["alpha", true]]);
    const ws = await service.createWorkspace({ projectId: null });
    expect(ws.session.session.harness).toBe("alpha");
    await expect(service.createSession(ws.workspace.id, { harness: "beta" })).rejects.toMatchObject({ status: 400, message: "Beta is turned off on Air" });
    service.updateSettings({ agents: { alpha: { enabled: false } } });
    expect(service.listHarnesses()).toEqual([]);
    await expect(service.createWorkspace({ projectId: null })).rejects.toMatchObject({ status: 400 });
  });

  it("chats on a turned-off agent stay readable; sending to them says it's off", async () => {
    const { service, beta, restart } = setup();
    service.updateSettings({ agent: { defaultHarness: "beta" } });
    const ws = await service.createWorkspace({ projectId: null, prompt: "hello beta" });
    await flush(20);
    const id = ws.session.session.id;
    service.updateSettings({ agents: { beta: { enabled: false } } });
    await expect(service.prompt(id, { text: "again" })).rejects.toMatchObject({ status: 409, message: "Beta is turned off on Air" });

    // After a restart, opening it reads the store and starts nothing.
    const again = await restart();
    const open = vi.spyOn(beta, "openSession");
    const detail = await again.getSessionDetail(id);
    expect(detail.offline).toBe(true);
    expect(detail.transcript.messages.some((m) => m.role === "user")).toBe(true);
    expect(open).not.toHaveBeenCalled();
    await expect(again.prompt(id, { text: "again" })).rejects.toMatchObject({ status: 409, message: "Beta is turned off on Air" });
    // Turned back on: it works again.
    again.updateSettings({ agents: { beta: { enabled: true } } });
    await again.prompt(id, { text: "back" });
    expect(open).toHaveBeenCalled();
  });

  it("the catalog lists every agent: installed or not, enabled, offered, install links", () => {
    const { store, registry, service } = setup({ gemini: true });
    service.updateSettings({ agents: { "acp-gemini-cli": { enabled: false } } });
    const catalog = buildAgentCatalog({ harnesses: registry, settings: store().getSettings() as Settings });
    const byId = new Map(catalog.map((e) => [e.id, e] as [string, AgentCatalogEntry]));
    expect([...byId.keys()]).toEqual(["alpha", "beta", "acp-gemini-cli", "acp-claude-code", "acp-codex"]);
    expect(byId.get("alpha")).toMatchObject({ kind: "builtin", installed: true, enabled: true, offered: true, isDefault: true });
    expect(byId.get("acp-gemini-cli")).toMatchObject({ kind: "known", installed: true, enabled: false, offered: false, command: "gemini --experimental-acp" });
    expect(byId.get("acp-claude-code")).toMatchObject({ kind: "known", installed: false, offered: false });
    expect(byId.get("acp-claude-code")!.installUrl).toMatch(/^https:\/\//);
    expect(service.listHarnesses().map((h) => h.id)).toEqual(["alpha", "beta"]);
  });

  it("custom ACP agents that aren't installed are listed but not offered", () => {
    const { service } = setup();
    service.updateSettings({ harnesses: { acp: { agents: [{ id: "mine", name: "Mine", command: "mine-acp", args: [], env: {} }] } } });
    expect(service.listHarnesses().map((h) => h.id)).toEqual(["alpha", "beta"]);
    const mine = service.agentCatalog().find((e) => e.id === "acp-mine");
    expect(mine).toMatchObject({ kind: "custom", installed: false, offered: false, command: "mine-acp" });
  });

  it("models are tagged with the harness that lists them", async () => {
    const { service } = setup();
    const models = await service.listModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.harness === "alpha")).toBe(true);
  });
});

describe("settings are changed on the device only (HTTP)", () => {
  const HOST = "127.0.0.1:4317";
  const OTHER = "http://127.0.0.1:4400";

  async function start() {
    const dir = tempDir();
    const store = new Store(join(dir, "data"), 0);
    const service = new AppService({ store, harnesses: new HarnessRegistry([new FakeHarness()]), scratchDir: join(dir, "scratch"), sync: { batchMs: 10_000 } });
    const auth = new AuthService({
      db: store.db,
      environmentId: service.environment.id,
      environmentName: () => "Air",
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
    });
    const call = (method: string, path: string, o: { body?: unknown; token?: string; remote?: boolean } = {}) =>
      app.request(
        path,
        {
          method,
          headers: {
            host: HOST,
            ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
            ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
            ...(o.remote ? { origin: OTHER } : {}),
          },
          body: o.body === undefined ? undefined : JSON.stringify(o.body),
        },
        { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
      );
    // Pair a device (invite → pair → Allow).
    expect((await call("PATCH", "/api/auth/remote", { body: { enabled: true } })).status).toBe(200);
    const invite = (await (await call("POST", "/api/auth/invites")).json()) as PairingInvite;
    const grant = new URL(invite.link.replace("glade://", "http://x/")).searchParams.get("g")!;
    const pairing = call("POST", "/api/auth/pair", { body: { grant, deviceName: "Pro", deviceKind: "mac" }, remote: true });
    for (let i = 0; i < 400; i++) {
      const list = (await (await call("GET", "/api/auth/pending")).json()) as { id: string }[];
      if (list.length) {
        await call("POST", `/api/auth/pending/${list[0]!.id}`, { body: { allow: true } });
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const paired = (await (await pairing).json()) as PairResponse;
    if (paired.status !== "paired") throw new Error("not paired");
    return { call, token: paired.token, service };
  }

  it("a paired device reads settings, agents and models but can't change them", async () => {
    const { call, token, service } = await start();
    for (const path of ["/api/settings", "/api/harnesses", "/api/agent-catalog", "/api/models"]) {
      expect((await call("GET", path, { token, remote: true })).status, path).toBe(200);
    }
    const patches: Array<Record<string, unknown>> = [
      { agents: { fake: { enabled: false } } },
      { models: { hiddenModels: ["x/y"] } },
      { slashCommands: { hidden: ["builtin:compact"] } },
      { prompts: [] },
      { harnesses: { pi: { piPath: "/tmp/pi" } } },
    ];
    for (const body of patches) {
      const res = await call("PATCH", "/api/settings", { token, remote: true, body });
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(await res.json()).toMatchObject({ code: "local_only", error: expect.stringContaining("Change this on") });
    }
    expect(service.getSettings().agents).toEqual({});
    // The host itself can.
    expect((await call("PATCH", "/api/settings", { body: { agents: { fake: { enabled: false } } } })).status).toBe(200);
    expect(service.getSettings().agents).toEqual({ fake: { enabled: false } });
  });
});
