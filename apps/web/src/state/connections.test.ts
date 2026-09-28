/** I-136: merging saved environments and paired devices into one Connections list. */
import { describe, expect, it } from "vitest";
import type { PairedDevice } from "@glade/protocol";
import { mergeConnections } from "./connections";
import type { SavedEnvironment } from "./saved-environments";

const env = (id: string): SavedEnvironment => ({ id, name: id, urls: [`https://${id}.ts.net`] });
const dev = (id: string, clientEnvironmentId: string | null, createdAt = 1): PairedDevice => ({
  id,
  name: id,
  kind: "mac",
  createdAt,
  lastSeenAt: null,
  lastAddress: null,
  tailscaleLogin: null,
  clientEnvironmentId,
  scopes: ["full"],
  connected: false,
});

describe("mergeConnections", () => {
  it("only you use it, only it uses you, and both as one entry", () => {
    const list = mergeConnections([env("A"), env("B")], [dev("d-b", "B"), dev("d-c", "C"), dev("d-x", null)]);
    expect(list.map((c) => [c.key, c.environment?.id ?? null, c.device?.id ?? null])).toEqual([
      ["A", "A", null],
      ["B", "B", "d-b"],
      ["device:d-c", null, "d-c"],
      ["device:d-x", null, "d-x"],
    ]);
  });

  it("the newest pairing of the same device joins the environment; an older one stays separate", () => {
    const list = mergeConnections([env("A")], [dev("old", "A", 1), dev("new", "A", 5)]);
    expect(list.map((c) => [c.key, c.device?.id])).toEqual([
      ["A", "new"],
      ["device:old", "old"],
    ]);
  });

  it("empty", () => {
    expect(mergeConnections([], [])).toEqual([]);
  });
});
