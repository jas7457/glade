/**
 * Settings → Remote Access (I-123, I-125/I-126, I-127; layout I-132):
 *
 * 1. **Remote access** master switch (off by default; `state/remote-master.ts`). Off: nothing
 *    below is shown, remote environments are hidden and disconnected, and this Mac doesn't
 *    accept devices (nothing is deleted). With a local server, the Tailscale row follows (the
 *    transport serves both directions).
 * 2. **Your environments**: "Connect to Environment…" (pairing by link or code,
 *    `ConnectEnvironmentDialog`), the environments this device paired with and their status
 *    (`state/remote-status.ts`: Retry, Pair Again…, Remove), and Glade Macs found on the tailnet.
 * 3. **Let other devices use this Mac** (local server only, `HostRemoteAccess`).
 */
import { useEffect, useState } from "preact/hooks";
import { Plus, Trash2 } from "lucide-preact";
import type { DiscoveredEnvironment } from "@glade/protocol";
import { hostAuth } from "@/lib/api-auth";
import { connectionFor, hasLocalEnvironment, localEnvironmentId } from "@/state/env-registry";
import { removeSavedEnvironment, savedEnvironments, type SavedEnvironment } from "@/state/environments";
import { pairDialogRequest } from "@/state/pairing";
import { hostRemote, loadHostRemote } from "@/state/remote-host";
import { remoteMaster, remoteMasterError, setRemoteMaster } from "@/state/remote-master";
import { remoteStateOf, remoteStateText } from "@/state/remote-status";
import { Button, FormGroup, FormRow, IconButton, Switch, confirm } from "@/ui";
import { ConnectEnvironmentDialog } from "./ConnectEnvironmentDialog";
import { HostRemoteAccess } from "./HostRemoteAccess";
import { TransportStatusRow } from "./TransportStatus";

const HOST_POLL_MS = 10_000;

interface DialogRequest {
  link?: string;
  envId?: string;
  address?: string;
}

export function RemoteAccessSettings() {
  const master = remoteMaster.value;
  const local = hasLocalEnvironment.value;
  const host = hostRemote.value;
  const [dialog, setDialog] = useState<DialogRequest | null>(null);

  // A `/pair?link=…` deep link or "Pair Again…" elsewhere asked for the dialog.
  const request = pairDialogRequest.value;
  useEffect(() => {
    if (!request) return;
    setDialog(request);
    pairDialogRequest.value = null;
  }, [request]);

  // The master switch, the host switch and Tailscale's state change without pushes: refresh while shown.
  useEffect(() => {
    if (!local) return;
    void loadHostRemote();
    const timer = setInterval(() => void loadHostRemote(), HOST_POLL_MS);
    return () => clearInterval(timer);
  }, [local]);

  return (
    <>
      <FormGroup
        footer={
          master
            ? undefined
            : "Open projects and chats of your other Macs here, and let them use this one, over your private Tailscale network. Nothing is deleted when it's off."
        }
      >
        <FormRow label="Remote access" description="Use Glade across your devices" htmlFor="remote-master">
          <Switch id="remote-master" checked={master} onCheckedChange={(on) => void setRemoteMaster(on)} />
        </FormRow>
        {master && local && host?.transport && <TransportStatusRow status={host.transport} enabled={host.enabled} />}
        {remoteMasterError.value && (
          <FormRow label={<span role="alert" class="text-danger">{remoteMasterError.value}</span>} />
        )}
      </FormGroup>

      {master && (
        <>
          <YourEnvironments onDialog={setDialog} />
          {local && <HostRemoteAccess />}
        </>
      )}
      <ConnectEnvironmentDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        initialLink={dialog?.link}
        initialAddress={dialog?.address}
        envId={dialog?.envId}
      />
    </>
  );
}

function YourEnvironments({ onDialog }: { onDialog: (request: DialogRequest) => void }) {
  const saved = savedEnvironments.value;
  const found = useDiscovered(saved);

  const remove = async (id: string, name: string) => {
    const ok = await confirm({
      title: "Remove environment?",
      subject: name,
      message: "will be removed from this device's list. Nothing on it is deleted; you can pair again later.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (ok) removeSavedEnvironment(id);
  };

  return (
    <FormGroup
      title="Your environments"
      actions={
        <Button size="sm" onClick={() => onDialog({})}>
          <Plus size={12} />
          Connect to Environment…
        </Button>
      }
    >
      {saved.length === 0 && found.length === 0 && <FormRow label={<span class="text-fg-muted">No other environments yet.</span>} />}
      {saved.map((e) => (
        <SavedRow key={e.id} entry={e} onPair={() => onDialog({ envId: e.id })} onRemove={() => void remove(e.id, e.name)} />
      ))}
      {found.map((d) => (
        <FormRow key={d.address} label={d.name} description={`${new URL(d.address).host} · Found on your tailnet`}>
          <Button size="sm" onClick={() => onDialog({ address: d.address })}>
            Connect…
          </Button>
        </FormRow>
      ))}
    </FormGroup>
  );
}

function SavedRow({ entry, onPair, onRemove }: { entry: SavedEnvironment; onPair: () => void; onRemove: () => void }) {
  const conn = connectionFor(entry.id);
  const name = conn?.name.value ?? entry.name;
  const state = remoteStateOf(entry.id);
  let host = entry.urls[0] ?? "";
  try {
    host = new URL(host).host;
  } catch {
    /* keep as typed */
  }
  return (
    <FormRow label={name} description={<span data-testid="environment-status">{`${host} · ${remoteStateText(state, name)}`}</span>}>
      {state === "needs-pairing" && (
        <Button size="sm" onClick={onPair}>
          Pair Again…
        </Button>
      )}
      {(state === "unreachable" || state === "host-offline") && conn?.retry && (
        <Button size="sm" onClick={() => conn.retry?.()}>
          Retry
        </Button>
      )}
      <IconButton size="sm" label={`Remove ${name}`} onClick={onRemove}>
        <Trash2 />
      </IconButton>
    </FormRow>
  );
}

/** Glade Macs on this Mac's tailnet that this device hasn't paired with (local server only). */
function useDiscovered(saved: SavedEnvironment[]): DiscoveredEnvironment[] {
  const [found, setFound] = useState<DiscoveredEnvironment[]>([]);
  const local = hasLocalEnvironment.value;
  useEffect(() => {
    if (!local) return;
    let live = true;
    Promise.resolve()
      .then(() => hostAuth.discover())
      .then(
        (list) => live && Array.isArray(list) && setFound(list.filter((d) => d.reachable)),
        () => {},
      );
    return () => {
      live = false;
    };
  }, [local]);
  const own = localEnvironmentId.value;
  return found.filter((d) => d.environmentId !== own && !saved.some((s) => s.id === d.environmentId || s.urls.includes(d.address)));
}
