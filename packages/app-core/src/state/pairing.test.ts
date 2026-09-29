/**
 * I-125/I-126 client core: the pair flow (mocked fetch), token-aware connections (bearer header,
 * ws ticket on every connect), 401 → "needs pairing", and re-pairing replacing the connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, type EnvironmentInfo, type PairResponse } from "@glade/protocol";
import { localBaseUrl } from "@glade/app-core/lib/api";
import { resetEnvironmentsForTest } from "@glade/app-core/test/env-fixtures";
import { connectionFor, localEnvironmentId } from "./env-registry";
import { resetRemoteMaster } from "./remote-master";
import { remoteAccessEnabled, resetEnvironments, setRemoteAccessEnabled, startEnvironments } from "./environments";
import { runPairing, type PairState } from "./pairing";
import { flushSecretWrites, savedEnvironments, saveEnvironments } from "./saved-environments";
import * as store from "./store";

const info = (id: string, name: string): EnvironmentInfo => ({
  id,
  name,
  version: "0",
  protocol: 2,
  platform: "darwin",
  hostname: name,
  home: "/Users/me",
  capabilities: { openIn: true, reveal: true, nativeFolderPicker: true, browse: true, remoteAccess: true },
});

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Routes `METHOD url` to handlers; unknown URLs fail like an unreachable host. */
function stubFetch(routes: Record<string, Handler>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = `${method} ${url.split("?")[0]}`;
      const handler = routes[key];
      if (handler) return handler(init);
      if (url.startsWith(localBaseUrl()) || url.includes("5418")) {
        const path = url.split("?")[0]!;
        return json(path.endsWith("/settings") ? defaultSettings() : path.endsWith("/models/default") ? { model: null, thinkingLevel: null } : []);
      }
      throw new TypeError("Failed to fetch");
    }),
  );
  return calls;
}

const B = "http://127.0.0.1:5418/api";
const target = { environmentId: "ENV-B", name: "Studio", urls: ["http://10.9.9.9:1", "http://127.0.0.1:5418"], grant: "GRANT" };
const paired = (id = "ENV-B"): PairResponse => ({
  status: "paired",
  token: "TOKEN-1",
  environmentId: id,
  device: { id: "dev1", name: "MacBook Air", kind: "mac", createdAt: 1, lastSeenAt: null, lastAddress: null, tailscaleLogin: null, scopes: ["full"], connected: false },
});

beforeEach(() => {
  localStorage.clear();
  resetRemoteMaster();
  saveEnvironments([]);
  remoteAccessEnabled.value = false;
  resetEnvironmentsForTest();
  store.resetShellSync();
  localEnvironmentId.value = "ENV-A";
});
afterEach(() => {
  resetEnvironments();
  vi.unstubAllGlobals();
});

describe("runPairing", () => {
  it("tries the urls in order, checks the id, waits for the host and saves the token", async () => {
    const calls = stubFetch({
      [`GET ${B}/environment`]: () => json(info("ENV-B", "Studio")),
      [`POST ${B}/auth/pair`]: () => json(paired()),
    });
    const states: PairState[] = [];
    const result = await runPairing(target, { deviceName: "MacBook Air", deviceKind: "mac", onState: (s) => states.push(s), probeTimeoutMs: 50 });
    expect(states.map((s) => s.step)).toEqual(["connecting", "waiting", "paired"]);
    expect(states[1]).toEqual({ step: "waiting", hostName: "Studio" });
    expect(result).toMatchObject({ step: "paired" });
    const pair = calls.find((c) => c.url.endsWith("/auth/pair"))!;
    expect(pair.body).toEqual({ grant: "GRANT", deviceName: "MacBook Air", deviceKind: "mac", clientEnvironmentId: "ENV-A" });
    expect(pair.headers.authorization).toBeUndefined();
    // The address that answered goes first.
    expect(savedEnvironments.value).toEqual([
      { id: "ENV-B", name: "Studio", urls: ["http://127.0.0.1:5418", "http://10.9.9.9:1"], token: "TOKEN-1", deviceId: "dev1" },
    ]);
    // I-134: the list keeps no token; it goes to the secret store (localStorage fallback here).
    expect(JSON.parse(localStorage.getItem("glade.environments")!)[0].token).toBeUndefined();
    await flushSecretWrites();
    expect(localStorage.getItem("glade.secret.env:ENV-B")).toBe("TOKEN-1");
  });

  it.each<[string, PairResponse["status"], string]>([
    ["denied", "denied", "didn't allow"],
    ["expired", "expired", "expired"],
    ["timeout", "timeout", "Nobody answered"],
  ])("reports %s", async (_name, status, text) => {
    stubFetch({
      [`GET ${B}/environment`]: () => json(info("ENV-B", "Studio")),
      [`POST ${B}/auth/pair`]: () => json({ status }),
    });
    const result = await runPairing(target, { deviceName: "x", deviceKind: "mac", probeTimeoutMs: 50 });
    expect(result).toMatchObject({ step: "error", kind: status, message: expect.stringContaining(text) });
    expect(savedEnvironments.value).toEqual([]);
  });

  it("refuses a different environment at the address, and unreachable hosts", async () => {
    stubFetch({ [`GET ${B}/environment`]: () => json(info("ENV-X", "Other")) });
    expect(await runPairing(target, { deviceName: "x", deviceKind: "mac", probeTimeoutMs: 50 })).toMatchObject({ step: "error", kind: "wrong-environment" });
    stubFetch({});
    expect(await runPairing(target, { deviceName: "x", deviceKind: "mac", probeTimeoutMs: 50 })).toMatchObject({
      step: "error",
      kind: "unreachable",
      message: expect.stringContaining("10.9.9.9:1, 127.0.0.1:5418"),
    });
  });

  it("pairs with a host that wants a token for its info, checking the id in the answer", async () => {
    stubFetch({
      [`GET ${B}/environment`]: () => json({ code: "unauthorized", error: "no" }, 401),
      [`POST ${B}/auth/pair`]: () => json(paired()),
    });
    expect(await runPairing(target, { deviceName: "x", deviceKind: "mac", probeTimeoutMs: 50 })).toMatchObject({ step: "paired", environment: { id: "ENV-B", name: "Studio" } });
    stubFetch({
      [`GET ${B}/environment`]: () => json({ code: "unauthorized", error: "no" }, 401),
      [`POST ${B}/auth/pair`]: () => json(paired("ENV-X")),
    });
    saveEnvironments([]);
    expect(await runPairing(target, { deviceName: "x", deviceKind: "mac", probeTimeoutMs: 50 })).toMatchObject({ kind: "wrong-environment" });
    expect(savedEnvironments.value).toEqual([]);
  });

  it("maps remote_disabled, bad codes and rate limits", async () => {
    const answers = [json({ code: "remote_disabled", error: "off" }, 403), json({ error: "bad grant" }, 400), json({ error: "slow down" }, 429)];
    stubFetch({ [`GET ${B}/environment`]: () => json(info("ENV-B", "Studio")), [`POST ${B}/auth/pair`]: () => answers.shift()! });
    const run = () => runPairing(target, { deviceName: "x", deviceKind: "mac", probeTimeoutMs: 50 });
    expect(await run()).toMatchObject({ kind: "remote-disabled" });
    expect(await run()).toMatchObject({ kind: "invalid" });
    expect(await run()).toMatchObject({ kind: "rate-limited" });
  });

  it("can be cancelled while waiting", async () => {
    stubFetch({
      [`GET ${B}/environment`]: () => json(info("ENV-B", "Studio")),
      [`POST ${B}/auth/pair`]: (init) =>
        new Promise((_, reject) => {
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (init?.signal?.aborted) abort();
          init?.signal?.addEventListener("abort", abort);
        }),
    });
    const controller = new AbortController();
    const done = runPairing(target, {
      deviceName: "x",
      deviceKind: "mac",
      probeTimeoutMs: 50,
      signal: controller.signal,
      onState: (s) => {
        if (s.step === "waiting") setTimeout(() => controller.abort(), 5);
      },
    });
    expect(await done).toEqual({ step: "cancelled" });
  });
});

describe("authenticated connections", () => {
  class FakeWs {
    static urls: string[] = [];
    static OPEN = 1;
    readyState = 0;
    onopen = null;
    onmessage = null;
    onclose = null;
    constructor(url: string) {
      FakeWs.urls.push(url);
    }
    send() {}
    close() {}
  }

  it("sends the bearer token, connects the socket with a ticket, and turns 401 into needs-pairing", async () => {
    FakeWs.urls = [];
    vi.stubGlobal("WebSocket", FakeWs);
    let revoked = false;
    const calls = stubFetch({
      [`GET ${localBaseUrl()}/environment`]: () => json(info("ENV-A", "Air")),
      [`GET ${B}/environment`]: () => (revoked ? json({ code: "unauthorized", error: "no" }, 401) : json(info("ENV-B", "Studio"))),
      [`POST ${B}/auth/ws-ticket`]: () => json({ ticket: "TICKET 1", expiresAt: 0 }),
      [`GET ${B}/projects`]: () => (revoked ? json({ code: "unauthorized", error: "revoked" }, 401) : json([])),
    });
    saveEnvironments([{ id: "ENV-B", name: "Studio", urls: ["http://127.0.0.1:5418"], token: "TOKEN-1" }]);
    await startEnvironments({ localBaseUrl: localBaseUrl() });
    setRemoteAccessEnabled(true);
    const conn = connectionFor("ENV-B")!;
    await vi.waitFor(() => expect(FakeWs.urls).toContain("ws://127.0.0.1:5418/ws?ticket=TICKET%201"));
    const remoteCalls = calls.filter((c) => c.url.startsWith(B));
    expect(remoteCalls.length).toBeGreaterThan(2);
    expect(remoteCalls.every((c) => c.headers.authorization === "Bearer TOKEN-1")).toBe(true);
    // The page's own server never gets a token.
    expect(calls.filter((c) => c.url.startsWith(localBaseUrl())).every((c) => !c.headers.authorization)).toBe(true);

    revoked = true;
    await conn.api.listProjects().catch(() => {});
    expect(conn.status.value).toBe("needs-pairing");

    // Paired again: a new token replaces the connection.
    revoked = false;
    saveEnvironments([{ id: "ENV-B", name: "Studio", urls: ["http://127.0.0.1:5418"], token: "TOKEN-2" }]);
    const next = connectionFor("ENV-B")!;
    expect(next).not.toBe(conn);
    await vi.waitFor(() => expect(calls.some((c) => c.headers.authorization === "Bearer TOKEN-2")).toBe(true));
  });
});
