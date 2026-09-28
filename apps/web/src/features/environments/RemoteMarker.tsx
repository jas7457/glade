/**
 * The remote badge for something of another environment (I-123): nothing for local items,
 * otherwise `ui/RemoteBadge` with the environment's name, address and status.
 */
import { connectionFor, isLocalEnvironment } from "@/state/env-registry";
import { environmentAddress } from "@/state/environments";
import { RemoteBadge } from "@/ui";

export function RemoteMarker({ envId, size, class: className }: { envId: string | null | undefined; size?: number; class?: string }) {
  if (!envId || isLocalEnvironment(envId)) return null;
  const conn = connectionFor(envId);
  if (!conn) return null;
  return <RemoteBadge name={conn.name.value} address={environmentAddress(conn)} status={conn.status.value} size={size} class={className} />;
}
