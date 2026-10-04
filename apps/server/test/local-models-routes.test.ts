/** I-196: /api/local-models routes on the real app (fake harness + fake llama-server router). */
import { afterEach, describe, expect, it } from "vitest";
import type { LocalModelsState, PairingInvite, PairResponse, ServerMessage } from "@glade/protocol";
import { createApp } from "../src/http/app.js";
import { AuthService } from "../src/services/auth/auth-service.js";
import { llamaBaseUrlEnv } from "../src/services/local-models/settings.js";
import { createTestEnv, type TestEnv } from "./helpers.js";
import { closedUrl, startFakeRouter, type FakeRouter } from "./fake-llama-router.js";

const HOST = "127.0.0.1:4317";
const OTHER = "http://127.0.0.1:4400";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup() {
  const router = await startFakeRouter({
    small: { status: "unloaded" },
    big: { status: "loaded", size: 9000, nCtx: 8192 },
  });
  const env: TestEnv = createTestEnv({ localModels: { fastMs: 5, slowMs: 1000 } });
  env.service.updateSettings({ localModels: { url: router.url } });
  const auth = new AuthService({
    db: env.store.db,
    environmentId: env.service.environment.id,
    environmentName: () => "Test Host",
    addresses: () => ["http://127.0.0.1:4317"],
    watchMs: 0,
    pairPollMs: 5,
    tailscaleLogin: async () => null,
  });
  const { app } = createApp({ service: env.service, auth, ownPorts: () => [4317] });
  cleanups.push(async () => {
    auth.dispose();
    await env.cleanup();
    await router.close();
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
  const local = (method: string, path: string, body?: unknown) => call(method, path, { body });
  const remote = (method: string, path: string, o: { body?: unknown; token?: string } = {}) => call(method, path, { ...o, headers: { origin: OTHER } });
  /** Pair a remote device (the host allows it) → its token. */
  const pairDevice = async (): Promise<string> => {
    expect((await local("PATCH", "/api/auth/remote", { enabled: true })).status).toBe(200);
    const invite = (await (await local("POST", "/api/auth/invites")).json()) as PairingInvite;
    const grant = new URL(invite.link.replace("glade://", "http://x/")).searchParams.get("g")!;
    const res = remote("POST", "/api/auth/pair", { body: { grant, deviceName: "iPhone", deviceKind: "phone" } });
    for (let i = 0; i < 400; i++) {
      const list = (await (await local("GET", "/api/auth/pending")).json()) as { id: string }[];
      if (list.length) {
        await local("POST", `/api/auth/pending/${list[0]!.id}`, { allow: true });
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const body = (await (await res).json()) as PairResponse;
    if (body.status !== "paired") throw new Error(`not paired: ${JSON.stringify(body)}`);
    return body.token;
  };
  const localModelsPushes = () => env.messages.filter((m): m is Extract<ServerMessage, { type: "local_models" }> => m.type === "local_models").map((m) => m.state);
  return { router, env, local, remote, pairDevice, localModelsPushes };
}

describe("/api/local-models", () => {
  it("GET returns the state; load and unload answer the new state; status codes", async () => {
    const t = await setup();
    const res = await t.local("GET", "/api/local-models");
    expect(res.status).toBe(200);
    const state = (await res.json()) as LocalModelsState;
    expect(state).toMatchObject({ backend: "llama-server", url: t.router.url, reachable: true, error: null, maxLoaded: 4 });
    expect(state.models.map((m) => [m.id, m.status])).toEqual([
      ["big", "loaded"],
      ["small", "unloaded"],
    ]);

    const load = await t.local("POST", "/api/local-models/load", { model: "small", contextLength: 4096 });
    expect(load.status).toBe(200);
    expect(((await load.json()) as LocalModelsState).models.find((m) => m.id === "small")!.status).toBe("loading");
    expect(t.router.requests).toContain("POST /models/load small");

    expect((await t.local("POST", "/api/local-models/load", { model: "small" })).status).toBe(409);
    expect((await t.local("POST", "/api/local-models/load", { model: "nope" })).status).toBe(404);
    expect((await t.local("POST", "/api/local-models/unload", { model: "nope" })).status).toBe(404);
    expect((await t.local("POST", "/api/local-models/load", {})).status).toBe(400);
    expect((await t.local("POST", "/api/local-models/load", { model: "small", contextLength: -1 })).status).toBe(400);

    // The load finishes: pushed, and the agents' models are refreshed for every client.
    const modelsBefore = t.env.messages.filter((m) => m.type === "models").length;
    t.router.finish("small");
    await expect.poll(() => t.localModelsPushes().at(-1)?.models.find((m) => m.id === "small")?.status).toBe("loaded");
    await expect.poll(() => t.env.messages.filter((m) => m.type === "models").length).toBe(modelsBefore + 1);

    const unload = await t.local("POST", "/api/local-models/unload", { model: "big" });
    expect(unload.status).toBe(200);
    expect(((await unload.json()) as LocalModelsState).models.find((m) => m.id === "big")!.status).toBe("unloaded");
    expect((await t.local("POST", "/api/local-models/unload", { model: "big" })).status).toBe(409);
  });

  it("502 when llama-server isn't running; GET says why", async () => {
    const t = await setup();
    const url = await closedUrl();
    t.env.service.updateSettings({ localModels: { url } });
    const state = (await (await t.local("GET", "/api/local-models?refresh=1")).json()) as LocalModelsState;
    expect(state).toMatchObject({ url, reachable: false, error: `llama-server isn't running at ${url}`, models: [] });
    const load = await t.local("POST", "/api/local-models/load", { model: "small" });
    expect(load.status).toBe(502);
    expect(((await load.json()) as { error: string }).error).toBe(`llama-server isn't running at ${url}`);
  });

  it("paired remote devices may load and unload (not host-only); unpaired ones may not", async () => {
    const t = await setup();
    const token = await t.pairDevice();
    expect((await t.remote("GET", "/api/local-models", { token })).status).toBe(200);
    expect((await t.remote("POST", "/api/local-models/load", { token, body: { model: "small" } })).status).toBe(200);
    expect((await t.remote("POST", "/api/local-models/unload", { token, body: { model: "big" } })).status).toBe(200);
    expect((await t.remote("POST", "/api/local-models/load", { body: { model: "small" } })).status).toBe(401);
  });

  it("settings: the URL must be http(s); a new URL is checked at once", async () => {
    const t = await setup();
    await t.local("GET", "/api/local-models");
    expect((await t.local("PATCH", "/api/settings", { localModels: { url: "ftp://x" } })).status).toBe(400);
    const other = await startFakeRouter({ only: { status: "unloaded" } });
    cleanups.push(() => other.close());
    expect((await t.local("PATCH", "/api/settings", { localModels: { url: other.url } })).status).toBe(200);
    await expect.poll(() => t.localModelsPushes().at(-1)?.models.map((m) => m.id)).toEqual(["only"]);
  });
});

describe("LLAMA_BASE_URL for agents", () => {
  it("passes the configured URL unless the server's env sets one", () => {
    expect(llamaBaseUrlEnv("http://127.0.0.1:8080", {})).toEqual({ LLAMA_BASE_URL: "http://127.0.0.1:8080" });
    expect(llamaBaseUrlEnv("http://127.0.0.1:8080", { LLAMA_BASE_URL: "http://elsewhere" })).toEqual({});
  });
});
