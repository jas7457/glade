import { beforeEach, describe, expect, it } from "vitest";
import type { SecretStore } from "@/lib/secret-store";
import { deviceId, resetDeviceIdCache } from "./secrets";

function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

describe("deviceId", () => {
  beforeEach(() => resetDeviceIdCache());

  it("makes a random id once and keeps it in the store", async () => {
    const store = memoryStore();
    const id = await deviceId(store);
    expect(id).toMatch(/^iphone-[0-9a-f]{32}$/);
    expect(store.data.get("device:id")).toBe(id);
    resetDeviceIdCache();
    expect(await deviceId(store)).toBe(id);
  });

  it("reuses a stored id", async () => {
    const store = memoryStore();
    store.data.set("device:id", "iphone-abc");
    expect(await deviceId(store)).toBe("iphone-abc");
  });
});
