/**
 * The remote badge for something of another environment (I-123): nothing for local items,
 * otherwise `ui/RemoteBadge` with the environment's name, address and status (I-132:
 * `state/remote-status.ts`, with Retry or Pair Again… when that helps).
 */
import { useNavigate } from "react-router";
import { routes } from "@glade/app-core/app/routes";
import { connectionFor, isLocalEnvironment } from "@glade/app-core/state/env-registry";
import { environmentAddress } from "@glade/app-core/state/environments";
import { pairDialogRequest } from "@glade/app-core/state/pairing";
import { remoteStateOf, remoteStateText } from "@glade/app-core/state/remote-status";
import { RemoteBadge } from "@glade/app-core/ui";

export function RemoteMarker({ envId, size, class: className }: { envId: string | null | undefined; size?: number; class?: string }) {
  const navigate = useNavigate();
  if (!envId || isLocalEnvironment(envId)) return null;
  const conn = connectionFor(envId);
  if (!conn) return null;
  const state = remoteStateOf(envId);
  const name = conn.name.value;
  return (
    <RemoteBadge
      name={name}
      address={environmentAddress(conn)}
      status={state}
      statusText={remoteStateText(state, name)}
      action={
        state === "needs-pairing"
          ? {
              label: "Pair Again…",
              onSelect: () => {
                pairDialogRequest.value = { envId: conn.id };
                navigate(routes.settings("remote"));
              },
            }
          : state === "unreachable" || state === "host-offline"
            ? { label: "Retry", onSelect: () => conn.retry?.() }
            : undefined
      }
      size={size}
      class={className}
    />
  );
}
