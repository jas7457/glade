/**
 * I-132 client: what a remote environment's status means (Connected, Remote access turned off,
 * offline, can't reach, needs pairing), the remembered refusal, offline via tailnet peers,
 * Retry, hiding a down environment's items, and the master switch stored on the local server
 * (with the legacy per-device switch migrated) or on the device (phone).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, type EnvironmentInfo } from "@glade/protocol";
import { localBaseUrl } from "@/lib/api";
import { makeProject } from "@/test/fixtures";
import { resetEnvironmentsForTest } from "@/test/env-fixtures";
import { connectionFor } from "./env-registry";
import { resetEnvironments, startEnvironments } from "./environments";
import { LEGACY_REMOTE_ACCESS_KEY, remoteMaster, resetRemoteMaster, setRemoteMaster } from "./remote-master";
import { resetRemoteHost } from "./remote-host";
import { deriveRemoteState, remoteStateOf, remoteStateText, tailnetPeers } from "./remote-status";
import { saveEnvironments, savedEnvironments } from "./saved-environments";
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
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const B = "http://studio.tail.ts.net/api";

class FakeWs {
  static all: FakeWs[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.all.push(this);
  }
  send() {}
  close() {}
  /** The server accepts and says hello (legacy protocol: live at once). */
  accept() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: "hello" }) });
  }
  shut(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
const socketsTo = (base: string) => FakeWs.all.filter((w) => w.url.startsWith(base.replace(/^http/, "ws").replace(/\/api$/, "")));

interface Net {
  bUp: boolean;
  master: boolean;
  peers: { dnsName: string; name: string; online: boolean }[];
  patches: unknown[];
}

function stubNetwork(net: Net) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = url.split("?")[0]!;
      if (path === `${localBaseUrl()}/auth/remote`) {
        if (method === "PATCH") {
          const body = JSON.parse(String(init!.body)) as { master?: boolean };
          net.patches.push(body);
          if (typeof body.master === "boolean") net.master = body.master;
        }
        return json({ enabled: false, master: net.master, addresses: [] });
      }
      if (path === `${localBaseUrl()}/auth/peers`) return json(net.peers);
      if (path === `${localBaseUrl()}/environment`) return json(info("ENV-A", "Air"));
      if (path.startsWith(localBaseUrl())) return json(path.endsWith("/settings") ? defaultSettings() : path.endsWith("/models/default") ? { model: null, thinkingLevel: null } : []);
      if (path.startsWith(B)) {
        if (!net.bUp) throw new TypeError("Failed to fetch");
        if (path === `${B}/environment`) return json(info("ENV-B", "Studio"));
        if (path === `${B}/auth/ws-ticket`) return json({ ticket: "T", expiresAt: 0 });
        if (path === `${B}/projects`) return json([makeProject({ id: "pb" })]);
        return json(path.endsWith("/settings") ? defaultSettings() : path.endsWith("/models/default") ? { model: null, thinkingLevel: null } : []);
      }
      throw new TypeError("Failed to fetch");
    }),
  );
  vi.stubGlobal("WebSocket", FakeWs);
}

beforeEach(() => {
  localStorage.clear();
  FakeWs.all = [];
  resetRemoteMaster();
  resetRemoteHost();
  resetEnvironmentsForTest();
  saveEnvironments([]);
  tailnetPeers.value = null;
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

describe("deriveRemoteState", () => {
  const base = { hasToken: true, rememberedDisabled: false, peerOnline: undefined };
  it("maps the connection, the remembered refusal and the peer's state", () => {
    expect(deriveRemoteState({ ...base, status: "live" })).toBe("connected");
    expect(deriveRemoteState({ ...base, status: "live", rememberedDisabled: true })).toBe("connected");
    expect(deriveRemoteState({ ...base, status: "connecting" })).toBe("connecting");
    expect(deriveRemoteState({ ...base, status: "remote-disabled" })).toBe("remote-disabled");
    // Remembered even once unreachable (serve was removed there), and while reconnecting.
    expect(deriveRemoteState({ ...base, status: "offline", rememberedDisabled: true, peerOnline: false })).toBe("remote-disabled");
    expect(deriveRemoteState({ ...base, status: "connecting", rememberedDisabled: true })).toBe("remote-disabled");
    expect(deriveRemoteState({ ...base, status: "offline", peerOnline: false })).toBe("host-offline");
    expect(deriveRemoteState({ ...base, status: "error", peerOnline: true })).toBe("unreachable");
    expect(deriveRemoteState({ ...base, status: "offline" })).toBe("unreachable");
    expect(deriveRemoteState({ ...base, status: "needs-pairing" })).toBe("needs-pairing");
    expect(deriveRemoteState({ ...base, status: "live", hasToken: false })).toBe("needs-pairing");
    expect(remoteStateText("remote-disabled", "Studio")).toBe("Remote access turned off on Studio");
    expect(remoteStateText("host-offline", "Studio")).toBe("Studio is offline");
    expect(remoteStateText("unreachable", "Studio")).toBe("Can't reach Studio");
  });
});

describe("remote environment status", () => {
  const start = async (net: Net) => {
    stubNetwork(net);
    saveEnvironments([{ id: "ENV-B", name: "Studio", urls: ["http://studio.tail.ts.net"], token: "TOKEN" }]);
    await startEnvironments({ localBaseUrl: localBaseUrl() });
    await vi.waitFor(() => expect(connectionFor("ENV-B")).toBeTruthy());
    return connectionFor("ENV-B")!;
  };

  it("remembers 'remote access turned off' (4403) while unreachable, hides its items, and reconnects on Retry", async () => {
    const net: Net = { bUp: true, master: true, peers: [], patches: [] };
    const conn = await start(net);
    await vi.waitFor(() => expect(socketsTo(B)).toHaveLength(1));
    socketsTo(B)[0]!.accept();
    await vi.waitFor(() => expect(remoteStateOf("ENV-B")).toBe("connected"));
    await vi.waitFor(() => expect(store.projects.value.map((p) => p.id)).toContain("pb"));

    // Remote access turned off on B: its socket is closed with 4403.
    socketsTo(B)[0]!.shut(4403);
    expect(remoteStateOf("ENV-B")).toBe("remote-disabled");
    expect(savedEnvironments.value[0]!.remoteDisabled).toBe(true);
    expect(store.projects.value.map((p) => p.id)).not.toContain("pb");

    // Its server stops (serve removed): unreachable, but it still says why.
    net.bUp = false;
    conn.retry!();
    await vi.waitFor(() => expect(conn.status.value).not.toBe("connecting"), { timeout: 3000 });
    expect(remoteStateOf("ENV-B")).toBe("remote-disabled");

    // Back with remote access on: Retry reconnects, the status clears and the items return.
    net.bUp = true;
    conn.retry!();
    await vi.waitFor(() => expect(socketsTo(B).length).toBeGreaterThan(1));
    socketsTo(B).at(-1)!.accept();
    await vi.waitFor(() => expect(remoteStateOf("ENV-B")).toBe("connected"));
    expect(savedEnvironments.value[0]!.remoteDisabled).toBeUndefined();
    await vi.waitFor(() => expect(store.projects.value.map((p) => p.id)).toContain("pb"));
  });

  it("says the Mac is offline when this Mac's Tailscale reports it offline, else can't reach", async () => {
    const net: Net = { bUp: false, master: true, peers: [{ dnsName: "studio.tail.ts.net", name: "studio", online: false }], patches: [] };
    const conn = await start(net);
    await vi.waitFor(() => expect(remoteStateOf("ENV-B")).toBe("host-offline"), { timeout: 3000 });
    net.peers = [{ dnsName: "studio.tail.ts.net", name: "studio", online: true }];
    const { refreshPeers } = await import("./remote-status");
    await refreshPeers();
    expect(remoteStateOf("ENV-B")).toBe("unreachable");
    conn.retry!();
    expect(conn.status.value).toBe("connecting");
  });
});

describe("coming back sooner (I-142)", () => {
  const start = async (net: Net) => {
    stubNetwork(net);
    saveEnvironments([{ id: "ENV-B", name: "Studio", urls: ["http://studio.tail.ts.net"], token: "TOKEN" }]);
    await startEnvironments({ localBaseUrl: localBaseUrl() });
    await vi.waitFor(() => expect(connectionFor("ENV-B")).toBeTruthy());
    await vi.waitFor(() => expect(socketsTo(B)).toHaveLength(1));
    socketsTo(B)[0]!.accept();
    await vi.waitFor(() => expect(remoteStateOf("ENV-B")).toBe("connected"));
    socketsTo(B)[0]!.shut(4403);
    expect(remoteStateOf("ENV-B")).toBe("remote-disabled");
  };

  it("retries a remote-disabled environment at once on window focus and when the window becomes visible", async () => {
    const net: Net = { bUp: true, master: true, peers: [], patches: [] };
    await start(net);
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(socketsTo(B)).toHaveLength(2));
    socketsTo(B)[1]!.accept();
    await vi.waitFor(() => expect(remoteStateOf("ENV-B")).toBe("connected"));

    socketsTo(B)[1]!.shut(4403);
    expect(remoteStateOf("ENV-B")).toBe("remote-disabled");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(socketsTo(B)).toHaveLength(3));
    // Connected meanwhile: focus doesn't open another socket.
    socketsTo(B)[2]!.accept();
    await vi.waitFor(() => expect(remoteStateOf("ENV-B")).toBe("connected"));
    window.dispatchEvent(new Event("focus"));
    await new Promise((r) => setTimeout(r, 20));
    expect(socketsTo(B)).toHaveLength(3);
  });

  it("retries only the environments asked for, and only while they wait", async () => {
    const net: Net = { bUp: true, master: true, peers: [], patches: [] };
    await start(net);
    const { retryWaitingRemotes } = await import("./environments");
    expect(retryWaitingRemotes(["OTHER"])).toEqual([]);
    expect(retryWaitingRemotes(["ENV-B"])).toEqual(["ENV-B"]);
    // Connecting now (not waiting): nothing more.
    expect(retryWaitingRemotes()).toEqual([]);
    await vi.waitFor(() => expect(socketsTo(B)).toHaveLength(2));
  });

  it("retries at once when discovery finds that device reachable", async () => {
    const net: Net = { bUp: true, master: true, peers: [], patches: [] };
    await start(net);
    const { retryFound, savedAmongFound } = await import("@/features/environments/use-discovery");
    const found = (address: string, environmentId?: string) => ({ name: "x", address, environmentId, reachable: true });
    expect(savedAmongFound([found("https://other.ts.net")], savedEnvironments.value)).toEqual([]);
    expect(savedAmongFound([found("http://studio.tail.ts.net")], savedEnvironments.value)).toEqual(["ENV-B"]);
    expect(retryFound([found("https://other.ts.net", "ENV-C")])).toEqual([]);
    expect(retryFound([found("https://moved.ts.net", "ENV-B")])).toEqual(["ENV-B"]);
    await vi.waitFor(() => expect(socketsTo(B)).toHaveLength(2));
    socketsTo(B)[1]!.accept();
    await vi.waitFor(() => expect(remoteStateOf("ENV-B")).toBe("connected"));
  });

  it("refreshes the tailnet peers on focus while a remote is unreachable", async () => {
    const net: Net = { bUp: false, master: true, peers: [{ dnsName: "studio.tail.ts.net", name: "studio", online: false }], patches: [] };
    stubNetwork(net);
    saveEnvironments([{ id: "ENV-B", name: "Studio", urls: ["http://studio.tail.ts.net"], token: "TOKEN" }]);
    await startEnvironments({ localBaseUrl: localBaseUrl() });
    await vi.waitFor(() => expect(remoteStateOf("ENV-B")).toBe("host-offline"), { timeout: 3000 });
    net.peers = [{ dnsName: "studio.tail.ts.net", name: "studio", online: true }];
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(remoteStateOf("ENV-B")).toBe("unreachable"));
  });
});

describe("master switch storage", () => {
  it("lives on the local server; the legacy per-device switch turns it on once", async () => {
    localStorage.setItem(LEGACY_REMOTE_ACCESS_KEY, "true");
    const net: Net = { bUp: true, master: false, peers: [], patches: [] };
    stubNetwork(net);
    await startEnvironments({ localBaseUrl: localBaseUrl() });
    await vi.waitFor(() => expect(net.patches).toEqual([{ master: true }]));
    expect(remoteMaster.value).toBe(true);
    expect(localStorage.getItem(LEGACY_REMOTE_ACCESS_KEY)).toBeNull();

    await setRemoteMaster(false);
    expect(net.patches.at(-1)).toEqual({ master: false });
    expect(remoteMaster.value).toBe(false);
  });

  it("without a local server (phone) it stays on the device", async () => {
    const net: Net = { bUp: true, master: false, peers: [], patches: [] };
    stubNetwork(net);
    await startEnvironments({ localBaseUrl: null });
    await setRemoteMaster(true);
    expect(localStorage.getItem("glade.remoteMaster")).toBe("true");
    expect(net.patches).toEqual([]);
  });
});
