/**
 * I-123 client core: per-environment API base URLs, merged + tagged stores, the cross-environment
 * order, the remote-access switch hiding/restoring remote environments, and namespaced storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, type EnvironmentInfo } from "@glade/protocol";
import { apiBaseFromUrl, createApi, localBaseUrl } from "@glade/app-core/lib/api";
import { wsUrlFromApiBase } from "@glade/app-core/lib/socket";
import { makeProject, makeSession, makeWorkspace } from "@glade/app-core/test/fixtures";
import { fakeEnv, resetEnvironmentsForTest, useEnvironments } from "@glade/app-core/test/env-fixtures";
import { connections, connectionFor, primaryEnvironmentId } from "./env-registry";
import { apiForProject, apiForSession, isThisMachine } from "./env-api";
import { interleave, keyEnv, orderKey, resetClientOrders, clientOrders } from "./env-order";
import * as store from "./store";
import { resetRemoteMaster } from "./remote-master";
import { reorderProjects } from "./actions";
import {
  envStorageKey,
  remoteAccessEnabled,
  resetEnvironments,
  savedEnvironments,
  setRemoteAccessEnabled,
  startEnvironments,
} from "./environments";

const envInfo = (id: string, name: string): EnvironmentInfo => ({
  id,
  name,
  version: "0",
  protocol: 2,
  platform: "darwin",
  hostname: name,
  home: "/Users/me",
  capabilities: { openIn: true, reveal: true, nativeFolderPicker: true, browse: true, remoteAccess: false },
});

/** A fake network: two servers (the page's own and "B" on port 5418). */
function stubNetwork(): { calls: string[] } {
  const calls: string[] = [];
  const local = localBaseUrl();
  const remote = "http://127.0.0.1:5418/api";
  const data: Record<string, unknown> = {
    [`${local}/environment`]: envInfo("ENV-A", "Mac A"),
    [`${local}/projects`]: [makeProject({ id: "pa" })],
    [`${local}/workspaces`]: [makeWorkspace({ id: "wa", projectId: "pa" })],
    [`${local}/sessions`]: [makeSession({ id: "sa", workspaceId: "wa" })],
    [`${remote}/environment`]: envInfo("ENV-B", "Mac B"),
    [`${remote}/projects`]: [makeProject({ id: "pb" })],
    [`${remote}/workspaces`]: [makeWorkspace({ id: "wb", projectId: "pb" }), makeWorkspace({ id: "wb2", projectId: null })],
    [`${remote}/sessions`]: [makeSession({ id: "sb", workspaceId: "wb" })],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(url);
      const key = url.split("?")[0]!;
      const body = key.endsWith("/settings") ? defaultSettings() : key in data ? data[key] : key.endsWith("/models/default") ? { model: null, thinkingLevel: null } : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  // Sockets never open in tests.
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      onopen = null;
      onmessage = null;
      onclose = null;
      send() {}
      close() {}
    },
  );
  return { calls };
}

beforeEach(() => {
  localStorage.clear();
  resetRemoteMaster();
  savedEnvironments.value = [];
  resetClientOrders();
  resetEnvironmentsForTest();
  store.resetShellSync();
  store.projects.value = [];
  store.workspaces.value = [];
  store.sessions.value = [];
});
afterEach(() => {
  resetEnvironments();
  resetRemoteMaster();
  vi.unstubAllGlobals();
});

describe("per-environment API clients", () => {
  it("sends every request to the environment's absolute base URL", async () => {
    const { calls } = stubNetwork();
    const client = createApi("http://127.0.0.1:5418/api");
    await client.listProjects();
    await client.getSettings();
    expect(calls).toEqual(["http://127.0.0.1:5418/api/projects", "http://127.0.0.1:5418/api/settings"]);
  });

  it("derives API and socket URLs from an address", () => {
    expect(apiBaseFromUrl("http://127.0.0.1:5418")).toBe("http://127.0.0.1:5418/api");
    expect(apiBaseFromUrl(" http://127.0.0.1:5418/api/ ")).toBe("http://127.0.0.1:5418/api");
    expect(wsUrlFromApiBase("http://127.0.0.1:5418/api")).toBe("ws://127.0.0.1:5418/ws");
    expect(wsUrlFromApiBase("https://mac.ts.net/api")).toBe("wss://mac.ts.net/ws");
    expect(localBaseUrl()).toBe(`${window.location.origin}/api`);
  });

  it("routes an item's requests to its environment", () => {
    const b = fakeEnv({ id: "B" });
    const { local } = useEnvironments(b);
    store.applyShellSnapshot({ projects: [makeProject({ id: "pb" })], workspaces: [], sessions: [makeSession({ id: "sb" })], settings: defaultSettings() }, "B");
    expect(apiForSession("sb")).toBe(b.api);
    expect(apiForProject("pb")).toBe(b.api);
    expect(apiForSession("unknown")).not.toBe(b.api); // untagged = local
    expect(isThisMachine("B", "openIn")).toBe(false);
    expect(isThisMachine(local.id, "openIn")).toBe(true);
  });
});

describe("merged stores", () => {
  it("tags each environment's items and replaces only that environment's on a snapshot", () => {
    useEnvironments(fakeEnv({ id: "B" }));
    const shell = (id: string) => ({ projects: [makeProject({ id })], workspaces: [], sessions: [], settings: defaultSettings() });
    store.applyShellSnapshot(shell("pa"), "local-env");
    store.applyShellSnapshot(shell("pb"), "B");
    expect(store.projects.value.map((p) => [p.id, p.environmentId])).toEqual([
      ["pa", "local-env"],
      ["pb", "B"],
    ]);
    store.applyShellSnapshot(shell("pb2"), "B");
    expect(store.projects.value.map((p) => p.id).sort()).toEqual(["pa", "pb2"]);
    // B's list check only prunes B's items.
    store.applyShellCheck({ projects: [], workspaces: [], sessions: [] }, "B");
    expect(store.projects.value.map((p) => p.id)).toEqual(["pa"]);
  });

  it("keeps each environment's settings apart", () => {
    const b = fakeEnv({ id: "B" });
    useEnvironments(b);
    const hidden = { ...defaultSettings(), models: { ...defaultSettings().models, agents: { pi: { hiddenModels: ["x/y"] } } } };
    store.applyShellSnapshot({ projects: [], workspaces: [], sessions: [], settings: hidden }, "B");
    expect(b.shell.settings.value.models.agents.pi?.hiddenModels).toEqual(["x/y"]);
    expect(store.settings.value.models.agents).toEqual({});
  });
});

describe("cross-environment order (client side)", () => {
  it("interleaves environments by the stored slots, each keeping its own server order", () => {
    const perEnv = new Map([
      ["A", ["a1", "a2"]],
      ["B", ["b1"]],
    ]);
    expect(interleave([], perEnv, ["A", "B"])).toEqual(["a1", "a2", "b1"]);
    expect(interleave([orderKey("B", "b1"), orderKey("A", "a1"), orderKey("A", "a2")], perEnv, ["A", "B"])).toEqual(["b1", "a1", "a2"]);
    expect(keyEnv(orderKey("B", "x"))).toBe("B");
  });

  it("dragging a remote project between local ones is kept on this device, not sent to either server", async () => {
    const bReorder = vi.fn(async (ids: string[]) => ids.map((id, i) => makeProject({ id, sortOrder: i })));
    useEnvironments(fakeEnv({ id: "B", api: { reorderProjects: bReorder } }));
    store.projects.value = [
      makeProject({ id: "a1", sortOrder: 0, environmentId: "local-env" }),
      makeProject({ id: "a2", sortOrder: 1, environmentId: "local-env" }),
      makeProject({ id: "b1", sortOrder: 0, environmentId: "B" }),
    ];
    expect(store.sortedProjects.value.map((p) => p.id)).toEqual(["a1", "a2", "b1"]);
    await reorderProjects(["a1", "b1", "a2"]);
    expect(store.sortedProjects.value.map((p) => p.id)).toEqual(["a1", "b1", "a2"]);
    expect(clientOrders.value.projects).toEqual(["local-env:a1", "B:b1", "local-env:a2"]);
    expect(JSON.parse(localStorage.getItem("glade.order")!).projects).toEqual(["local-env:a1", "B:b1", "local-env:a2"]);
    expect(bReorder).not.toHaveBeenCalled();
  });
});

describe("remote access switch", () => {
  it("off hides remote environments (nothing deleted); on restores them", async () => {
    stubNetwork();
    savedEnvironments.value = [{ id: "ENV-B", name: "Mac B", urls: ["http://127.0.0.1:5418"] }];
    expect(remoteAccessEnabled.value).toBe(false);
    await startEnvironments({ localBaseUrl: localBaseUrl() });
    await vi.waitFor(() => expect(store.projects.value.map((p) => p.id)).toEqual(["pa"]));
    expect(connections.value.map((c) => c.id)).toEqual(["ENV-A"]);

    setRemoteAccessEnabled(true);
    expect(connections.value.map((c) => c.id)).toEqual(["ENV-A", "ENV-B"]);
    await vi.waitFor(() => expect(store.projects.value.map((p) => p.id).sort()).toEqual(["pa", "pb"]));
    expect(store.envIdOfProject("pb")).toBe("ENV-B");
    expect(connectionFor("ENV-B")?.baseUrl).toBe("http://127.0.0.1:5418/api");

    setRemoteAccessEnabled(false);
    expect(connections.value.map((c) => c.id)).toEqual(["ENV-A"]);
    expect(store.projects.value.map((p) => p.id)).toEqual(["pa"]);
    expect(store.workspaces.value.map((w) => w.id)).toEqual(["wa"]);
    expect(savedEnvironments.value).toHaveLength(1); // still saved
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem("glade.remoteMaster")!)).toBe(false)); // older server: cached on the device

    setRemoteAccessEnabled(true);
    await vi.waitFor(() => expect(store.projects.value.map((p) => p.id).sort()).toEqual(["pa", "pb"]));
  });
});

describe("zero local environments (phone client, F-022)", () => {
  it("starts without a local server and uses the remote ones only", async () => {
    const { calls } = stubNetwork();
    savedEnvironments.value = [{ id: "ENV-B", name: "Mac B", urls: ["http://127.0.0.1:5418"] }];
    remoteAccessEnabled.value = true;
    await startEnvironments({ localBaseUrl: null });
    expect(store.initialized.value).toBe(true);
    expect(connections.value.map((c) => [c.id, c.isLocal])).toEqual([["ENV-B", false]]);
    expect(primaryEnvironmentId()).toBe("ENV-B");
    await vi.waitFor(() => expect(store.projects.value.map((p) => p.id)).toEqual(["pb"]));
    // Nothing was asked of the page's origin.
    expect(calls.every((u) => u.startsWith("http://127.0.0.1:5418/"))).toBe(true);
  });
});

describe("namespaced storage", () => {
  it("keys per-environment state by environment id; client prefs stay global", () => {
    expect(envStorageKey("ENV-B", "lastRoute")).toBe("glade.env.ENV-B.lastRoute");
    expect(orderKey("ENV-B", "p1")).toBe("ENV-B:p1");
  });
});
