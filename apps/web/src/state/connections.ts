/**
 * Settings → Remote Access → Connections (I-136): one entry per other device, merging both
 * directions.
 *
 * - **You use it**: a saved environment this device paired with (`saved-environments.ts`).
 * - **Uses this device**: a device paired to use this one (`remote-host.ts`, local server only).
 *
 * A paired device is the same machine as a saved environment when its `clientEnvironmentId` (sent
 * when it paired) is that environment's id; then it's one entry with both directions.
 *
 * Portable client core (F-022): pure, no layout.
 */
import type { PairedDevice } from "@glade/protocol";
import type { SavedEnvironment } from "./saved-environments";

export interface Connection {
  /** Stable key: the environment id, else `device:<id>`. */
  key: string;
  /** Set when this device uses it. */
  environment?: SavedEnvironment;
  /** Set when it uses this device. */
  device?: PairedDevice;
}

/** Saved environments first (in their order, each with its matching device), then devices that only use this one. */
export function mergeConnections(saved: readonly SavedEnvironment[], devices: readonly PairedDevice[]): Connection[] {
  const byEnv = new Map<string, PairedDevice>();
  for (const d of devices) {
    // The newest pairing wins if a device paired twice (the older one is usually stale).
    if (d.clientEnvironmentId && (!byEnv.has(d.clientEnvironmentId) || byEnv.get(d.clientEnvironmentId)!.createdAt < d.createdAt)) byEnv.set(d.clientEnvironmentId, d);
  }
  const used = new Set<string>();
  const out: Connection[] = saved.map((environment) => {
    const device = byEnv.get(environment.id);
    if (device) used.add(device.id);
    return device ? { key: environment.id, environment, device } : { key: environment.id, environment };
  });
  for (const device of devices) if (!used.has(device.id)) out.push({ key: `device:${device.id}`, device });
  return out;
}
