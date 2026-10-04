/** I-196: LocalModelsService: state, dedupe, polling only while connected, load/unload watching. */
import { afterEach, describe, expect, it } from "vitest";
import type { LocalModel, LocalModelsState, ServerMessage } from "@glade/protocol";
import { LocalModelsError, type LocalModelsBackend, type LocalModelsSnapshot } from "../src/services/local-models/backend.js";
import { LocalModelsService, type LocalModelUser, type LocalModelsServiceOptions } from "../src/services/local-models/service.js";

/** An in-memory backend: loads stay `loading` until `finish`. */
class MemoryBackend implements LocalModelsBackend {
  readonly kind = "llama-server" as const;
  calls = 0;
  reachable = true;
  models: LocalModel[];
  constructor(
    readonly url: string,
    models: Array<Pick<LocalModel, "id" | "status">>,
  ) {
    this.models = models.map((m) => ({ ...m, name: m.id, sizeBytes: 1, contextLength: null }));
  }
  async list(): Promise<LocalModelsSnapshot> {
    this.calls++;
    if (!this.reachable) return { reachable: false, error: `llama-server isn't running at ${this.url}`, models: [], maxLoaded: null };
    return { reachable: true, error: null, models: this.models.map((m) => ({ ...m })), maxLoaded: null };
  }
  async load(id: string): Promise<void> {
    this.set(id, "loading");
  }
  async unload(id: string): Promise<void> {
    this.set(id, "unloaded");
  }
  set(id: string, status: LocalModel["status"]): void {
    const m = this.models.find((x) => x.id === id);
    if (!m) throw new LocalModelsError(404, "nope");
    m.status = status;
  }
}

const services: LocalModelsService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.stop();
});

function setup(models: Array<Pick<LocalModel, "id" | "status">>, extra: Partial<LocalModelsServiceOptions> = {}) {
  const backends = new Map<string, MemoryBackend>();
  let url = "http://lm:1";
  const pushed: LocalModelsState[] = [];
  let modelRefreshes = 0;
  let users: LocalModelUser[] = [];
  let clock = 1000;
  const service = new LocalModelsService({
    url: () => url,
    backend: (u) => {
      const b = backends.get(u) ?? new MemoryBackend(u, models);
      backends.set(u, b);
      return b;
    },
    broadcast: (m: ServerMessage) => {
      if (m.type === "local_models") pushed.push(m.state);
    },
    users: () => users,
    onLoadedChange: () => modelRefreshes++,
    memoryBytes: 64 * 2 ** 30,
    fastMs: 5,
    slowMs: 40,
    now: () => clock++,
    ...extra,
  });
  services.push(service);
  return {
    service,
    pushed,
    backend: () => backends.get(url) ?? (backends.set(url, new MemoryBackend(url, models)), backends.get(url)!),
    setUrl: (u: string) => (url = u),
    setUsers: (u: LocalModelUser[]) => (users = u),
    refreshes: () => modelRefreshes,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("LocalModelsService", () => {
  it("builds the state and pushes only changes (fetchedAt ignored)", async () => {
    const t = setup([{ id: "a", status: "unloaded" }]);
    const state = await t.service.get();
    expect(state).toMatchObject({ backend: "llama-server", url: "http://lm:1", reachable: true, error: null, maxLoaded: null, memoryBytes: 64 * 2 ** 30 });
    expect(state.models.map((m) => m.id)).toEqual(["a"]);
    await t.service.get(true);
    await t.service.get(true);
    expect(t.pushed).toHaveLength(1);
    // Cached without refresh.
    const calls = t.backend().calls;
    await t.service.get();
    expect(t.backend().calls).toBe(calls);
    t.backend().reachable = false;
    await t.service.get(true);
    expect(t.pushed.at(-1)).toMatchObject({ reachable: false, error: "llama-server isn't running at http://lm:1", models: [] });
    expect(t.service.message()).toEqual({ type: "local_models", state: t.pushed.at(-1) });
  });

  it("polls only while a client is connected", async () => {
    const t = setup([{ id: "a", status: "unloaded" }]);
    t.service.start();
    await sleep(60);
    expect(t.backend().calls).toBe(0);
    t.service.setClientCount(1);
    await sleep(100);
    const connected = t.backend().calls;
    expect(connected).toBeGreaterThanOrEqual(2); // at once, then every slowMs
    t.service.setClientCount(0);
    await sleep(100);
    expect(t.backend().calls).toBeLessThanOrEqual(connected + 1);
  });

  it("load: loading → loaded pushes, then refreshes the agents' models once; watched without clients", async () => {
    const t = setup([
      { id: "a", status: "unloaded" },
      { id: "b", status: "loaded" },
    ]);
    t.service.start();
    await t.service.get();
    const after = await t.service.load("a");
    expect(after.models.find((m) => m.id === "a")!.status).toBe("loading");
    expect(t.refreshes()).toBe(0);
    await sleep(20);
    t.backend().set("a", "loaded");
    await expect.poll(() => t.pushed.at(-1)?.models.find((m) => m.id === "a")?.status).toBe("loaded");
    expect(t.pushed.map((s) => s.models.find((m) => m.id === "a")!.status)).toEqual(["unloaded", "loading", "loaded"]);
    expect(t.refreshes()).toBe(1);
    // Settled and no client: polling stops.
    const calls = t.backend().calls;
    await sleep(60);
    expect(t.backend().calls).toBe(calls);

    const unloaded = await t.service.unload("b");
    expect(unloaded.models.find((m) => m.id === "b")!.status).toBe("unloaded");
    expect(t.refreshes()).toBe(2);
  });

  it("checks requests against the state: 404 unknown, 409 already (not) loaded, 502 unreachable", async () => {
    const t = setup([
      { id: "a", status: "loaded" },
      { id: "b", status: "unloaded" },
      { id: "c", status: "loading" },
    ]);
    await expect(t.service.load("zzz")).rejects.toMatchObject({ status: 404 });
    await expect(t.service.load("a")).rejects.toMatchObject({ status: 409 });
    await expect(t.service.load("c")).rejects.toMatchObject({ status: 409 });
    await expect(t.service.unload("b")).rejects.toMatchObject({ status: 409 });
    t.backend().reachable = false;
    await expect(t.service.load("b")).rejects.toMatchObject({ status: 502 });
  });

  it("counts chats using a model (usedBy) and updates when chats change", async () => {
    const t = setup([
      { id: "a", status: "loaded" },
      { id: "b", status: "unloaded" },
    ]);
    t.setUsers([
      { sessionId: "s1", model: { provider: "llama.cpp", id: "a" }, running: true },
      { sessionId: "s2", model: { provider: "llama.cpp", id: "a" }, running: false },
      { sessionId: "s3", model: { provider: "anthropic", id: "a" }, running: true },
    ]);
    const state = await t.service.get();
    expect(state.models.find((m) => m.id === "a")!.usedBy).toEqual({ chats: 2, working: 1 });
    expect(state.models.find((m) => m.id === "b")!.usedBy).toBeUndefined();
    t.setUsers([]);
    t.service.usersChanged();
    expect(t.pushed.at(-1)!.models.find((m) => m.id === "a")!.usedBy).toBeUndefined();
    expect(t.pushed).toHaveLength(2);
  });

  it("a new URL is checked at once", async () => {
    const t = setup([{ id: "a", status: "unloaded" }]);
    t.service.start();
    await t.service.get();
    t.setUrl("http://lm:2");
    t.service.urlChanged();
    await expect.poll(() => t.pushed.at(-1)?.url).toBe("http://lm:2");
    // Switching servers isn't a load: no model list refresh.
    expect(t.refreshes()).toBe(0);
  });
});
