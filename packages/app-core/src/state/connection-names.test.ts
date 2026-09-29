/** I-138: each device names its connections itself — one name per other device, used everywhere. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairedDevice } from "@glade/protocol";

vi.mock("@glade/app-core/lib/api-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@glade/app-core/lib/api-auth")>();
  return { ...actual, hostAuth: { ...actual.hostAuth, renameDevice: vi.fn(async (id: string, name: string) => ({ ...device(id), name })) } };
});

import { hostAuth } from "@glade/app-core/lib/api-auth";
import { connectionName, mergeConnections, nameOfConnection } from "./connections";
import { connections, environmentLabel, localEnvironmentId } from "./env-registry";
import { EnvironmentConnection } from "./environments";
import { adoptDeviceName, pairedDevices, renameConnection, resetRemoteHost } from "./remote-host";
import { environmentAlias, saveEnvironments, savedEnvironments, setEnvironmentAlias } from "./saved-environments";

function device(id: string, extra: Partial<PairedDevice> = {}): PairedDevice {
  return { id, name: "MacBook Air", kind: "mac", createdAt: 1, lastSeenAt: null, lastAddress: null, tailscaleLogin: null, scopes: ["full"], connected: false, ...extra };
}

afterEach(() => {
  saveEnvironments([]);
  resetRemoteHost();
  connections.value = [];
  localEnvironmentId.value = null;
  vi.mocked(hostAuth.renameDevice).mockClear();
});

describe("connectionName", () => {
  it("alias > own name > host-side device name > fallback", () => {
    expect(connectionName({ alias: "Work", ownName: "MacBook Pro", deviceName: "Pro", fallback: "x" })).toBe("Work");
    expect(connectionName({ alias: "  ", ownName: "MacBook Pro", deviceName: "Pro", fallback: "x" })).toBe("MacBook Pro");
    expect(connectionName({ deviceName: "Pro", fallback: "x" })).toBe("Pro");
    expect(connectionName({ fallback: "host.ts.net" })).toBe("host.ts.net");
  });

  it("a Connections row: the environment's alias or own name; a device-only row its host-side name", () => {
    const [both, only] = mergeConnections([{ id: "E", name: "Saved", urls: [], alias: "Studio" }], [device("d1", { clientEnvironmentId: "E", name: "Air" }), device("d2", { name: "iPad" })]);
    expect(nameOfConnection(both!, "Live")).toBe("Studio");
    expect(nameOfConnection({ key: "E", environment: { id: "E", name: "Saved", urls: [] } }, "Live")).toBe("Live");
    expect(nameOfConnection({ key: "E", environment: { id: "E", name: "Saved", urls: [] } })).toBe("Saved");
    expect(nameOfConnection(only!)).toBe("iPad");
  });
});

describe("environment names follow the alias", () => {
  it("the connection's name (badge, pickers, notifications) is the alias, else its own name; This Mac stays", () => {
    saveEnvironments([{ id: "ENV-B", name: "Mac B", urls: ["http://127.0.0.1:5418"] }]);
    const conn = new EnvironmentConnection("ENV-B", "http://127.0.0.1:5418/api", false, "Mac B");
    const local = new EnvironmentConnection("ENV-A", "http://127.0.0.1:5417/api", true);
    local.info.value = { id: "ENV-A", name: "Air" } as never;
    connections.value = [local, conn];
    localEnvironmentId.value = "ENV-A";
    expect(conn.name.value).toBe("Mac B");
    conn.info.value = { id: "ENV-B", name: "MacBook Pro" } as never;
    expect(environmentLabel("ENV-B")).toBe("MacBook Pro");
    setEnvironmentAlias("ENV-B", "Work Mac");
    expect(conn.name.value).toBe("Work Mac");
    expect(environmentLabel("ENV-B")).toBe("Work Mac");
    expect(environmentLabel("ENV-A")).toBe("This Mac");
    setEnvironmentAlias("ENV-B", null);
    expect(environmentLabel("ENV-B")).toBe("MacBook Pro");
  });

  it("the alias is kept in the saved list (localStorage) without being sent anywhere", () => {
    saveEnvironments([{ id: "ENV-B", name: "Mac B", urls: ["http://x"] }]);
    setEnvironmentAlias("ENV-B", "Studio");
    expect(JSON.parse(localStorage.getItem("glade.environments")!)[0].alias).toBe("Studio");
  });
});

describe("renameConnection", () => {
  it("a device in both directions: one rename sets the host-side device name and the local alias", async () => {
    saveEnvironments([{ id: "ENV-B", name: "MacBook Pro", urls: ["http://x"] }]);
    pairedDevices.value = [device("d1", { clientEnvironmentId: "ENV-B", name: "MacBook Pro" })];
    const [row] = mergeConnections(savedEnvironments.value, pairedDevices.value);
    await renameConnection(row!, "Work Mac", "MacBook Pro");
    expect(hostAuth.renameDevice).toHaveBeenCalledWith("d1", "Work Mac");
    expect(environmentAlias("ENV-B")).toBe("Work Mac");
    expect(pairedDevices.value![0]!.name).toBe("Work Mac");
  });

  it("only you use it: alias only; renaming back to its own name clears it", async () => {
    saveEnvironments([{ id: "ENV-B", name: "MacBook Pro", urls: ["http://x"] }]);
    const row = { key: "ENV-B", environment: savedEnvironments.value[0]! };
    await renameConnection(row, "Studio", "MacBook Pro");
    expect(environmentAlias("ENV-B")).toBe("Studio");
    await renameConnection({ key: "ENV-B", environment: savedEnvironments.value[0]! }, "MacBook Pro", "MacBook Pro");
    expect(environmentAlias("ENV-B")).toBeUndefined();
    expect(hostAuth.renameDevice).not.toHaveBeenCalled();
  });

  it("only it uses this device: host-side name only", async () => {
    pairedDevices.value = [device("d2", { name: "iPad" })];
    await renameConnection({ key: "device:d2", device: pairedDevices.value[0]! }, "Tablet");
    expect(hostAuth.renameDevice).toHaveBeenCalledWith("d2", "Tablet");
  });

  it("a failed server rename leaves the alias alone", async () => {
    saveEnvironments([{ id: "ENV-B", name: "MacBook Pro", urls: ["http://x"] }]);
    pairedDevices.value = [device("d1", { clientEnvironmentId: "ENV-B" })];
    vi.mocked(hostAuth.renameDevice).mockRejectedValueOnce(new Error("nope"));
    const [row] = mergeConnections(savedEnvironments.value, pairedDevices.value);
    await expect(renameConnection(row!, "Work Mac")).rejects.toThrow("nope");
    expect(environmentAlias("ENV-B")).toBeUndefined();
  });

  it("pairing with a device that already uses this one keeps the name given to it here", () => {
    saveEnvironments([{ id: "ENV-B", name: "MacBook Pro", urls: ["http://x"] }]);
    pairedDevices.value = [device("d1", { clientEnvironmentId: "ENV-B", name: "Work Mac" })];
    adoptDeviceName("ENV-B");
    expect(environmentAlias("ENV-B")).toBe("Work Mac");
  });
});
