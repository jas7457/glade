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
 * Names (I-138): each device names its connections itself, one name per other device, used for
 * the whole row, the remote badge, pickers and notifications ({@link connectionName}; the
 * environment connections' `name` uses it too).
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

export interface NameParts {
  /** This device's own name for it (a saved environment's alias). */
  alias?: string | null;
  /** The other device's own environment name (live `GET /api/environment`). */
  ownName?: string | null;
  /** The name this host keeps for a paired device (its Rename, server side). */
  deviceName?: string | null;
  /** Last resort (the name saved when paired, or the address). */
  fallback: string;
}

/**
 * The one name this device shows for another device (I-138): its alias, else the other device's
 * own name, else (a device that only uses this one) the host-side device name, else `fallback`.
 */
export function connectionName({ alias, ownName, deviceName, fallback }: NameParts): string {
  return alias?.trim() || ownName?.trim() || deviceName?.trim() || fallback;
}

/** A Connections row's name; `ownName` is the environment's live name when it's connected. */
export function nameOfConnection(connection: Connection, ownName?: string | null): string {
  const { environment: env, device } = connection;
  if (env) return connectionName({ alias: env.alias, ownName, fallback: env.name });
  return connectionName({ deviceName: device?.name, fallback: "Device" });
}
