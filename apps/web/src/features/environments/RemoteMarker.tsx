/**
 * The remote badge for something of another environment (I-123): nothing for local items,
 * otherwise `ui/RemoteBadge` with the environment's name, address and status.
 */
import { useNavigate } from "react-router";
import { routes } from "@/app/routes";
import { connectionFor, isLocalEnvironment } from "@/state/env-registry";
import { environmentAddress } from "@/state/environments";
import { pairDialogRequest } from "@/state/pairing";
import { RemoteBadge } from "@/ui";

export function RemoteMarker({ envId, size, class: className }: { envId: string | null | undefined; size?: number; class?: string }) {
  const navigate = useNavigate();
  if (!envId || isLocalEnvironment(envId)) return null;
  const conn = connectionFor(envId);
  if (!conn) return null;
  const status = conn.status.value;
  const name = conn.name.value;
  return (
    <RemoteBadge
      name={name}
      address={environmentAddress(conn)}
      status={status}
      statusText={status === "remote-disabled" ? `Remote access is off on ${name}` : undefined}
      action={
        status === "needs-pairing"
          ? {
              label: "Pair Again…",
              onSelect: () => {
                pairDialogRequest.value = { envId: conn.id };
                navigate(routes.settings("remote"));
              },
            }
          : undefined
      }
      size={size}
      class={className}
    />
  );
}
