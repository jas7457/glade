/**
 * Settings → Remote Access (I-123, I-125/I-126, I-127, I-132; layout I-136), top to bottom:
 *
 * 1. **Remote access** master switch (off by default; `state/remote-master.ts`). Off: nothing
 *    else is shown, remote environments are hidden and disconnected, and this device doesn't
 *    accept others (nothing is deleted).
 * 2. **Let other devices use this device** (local server only, `SharingRows`), with this
 *    device's address under it while it's on, and "Keep this device awake while it's shared"
 *    (`KeepAwakeRows`, I-147).
 * 3. **Tailscale** status (local server only; the transport serves both directions).
 * 4. **Connections** (`Connections`): "Connect to a Device…" (`ConnectEnvironmentDialog`) and
 *    "Share This Device…" (`AddDeviceDialog`; offers to turn sharing on first) above one list of
 *    every other device, both directions merged.
 * 5. **Recent activity** (local server only).
 */
import { useEffect, useState } from "preact/hooks";
import { hasLocalEnvironment } from "@glade/app-core/state/env-registry";
import { retryWaitingRemotes } from "@glade/app-core/state/environments";
import { pairDialogRequest } from "@glade/app-core/state/pairing";
import { hostRemote, loadDevices, loadHostRemote, setHostRemote } from "@glade/app-core/state/remote-host";
import { remoteMaster, remoteMasterError, setRemoteMaster } from "@glade/app-core/state/remote-master";
import { refreshPeersIfNeeded } from "@glade/app-core/state/remote-status";
import { FormGroup, FormRow, Switch, confirm } from "@glade/app-core/ui";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { ConnectEnvironmentDialog } from "./ConnectEnvironmentDialog";
import { Connections } from "./Connections";
import { AuditLog, SharingRows } from "./HostRemoteAccess";
import { TransportStatusRow } from "./TransportStatus";
import { KeepAwakeRows } from "./KeepAwakeRows";

const HOST_POLL_MS = 10_000;

interface DialogRequest {
  link?: string;
  envId?: string;
  address?: string;
  name?: string;
}

/**
 * "Share This Device…": with sharing off, ask to turn it on first. Resolves true when sharing is
 * on (the invite dialog may open).
 */
export async function ensureSharing(): Promise<boolean> {
  if (hostRemote.value?.enabled) return true;
  const ok = await confirm({
    title: "Turn on sharing?",
    message: "Other devices can then ask to use this device's projects and chats. Each one needs your OK here.",
    confirmLabel: "Turn On",
  });
  if (!ok) return false;
  await setHostRemote(true);
  return hostRemote.value?.enabled === true;
}

export function RemoteAccessSettings() {
  const master = remoteMaster.value;
  const local = hasLocalEnvironment.value;
  const host = hostRemote.value;
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [sharing, setSharing] = useState(false);

  // A `/pair?link=…` deep link or "Pair Again…" elsewhere asked for the dialog.
  const request = pairDialogRequest.value;
  useEffect(() => {
    if (!request) return;
    setDialog(request);
    pairDialogRequest.value = null;
  }, [request]);

  // I-142: opening this page retries devices waiting to reconnect and refreshes the tailnet peers.
  useEffect(() => {
    retryWaitingRemotes();
    void refreshPeersIfNeeded();
  }, []);

  // The switches, Tailscale's state and the devices' last seen change without pushes: refresh while shown.
  useEffect(() => {
    if (!local) return;
    const refresh = () => {
      void loadHostRemote();
      if (remoteMaster.value) void loadDevices();
    };
    refresh();
    const timer = setInterval(refresh, HOST_POLL_MS);
    return () => clearInterval(timer);
  }, [local, master]);

  const share = async () => {
    if (await ensureSharing()) setSharing(true);
  };

  return (
    <>
      <FormGroup
        footer={
          master
            ? undefined
            : "Use projects and chats of your other computers here, and let them use this one, over your private Tailscale network. Nothing is deleted when it's off."
        }
      >
        <FormRow label="Remote access" description="Use Glade across your devices" htmlFor="remote-master">
          <Switch id="remote-master" checked={master} onCheckedChange={(on) => void setRemoteMaster(on)} />
        </FormRow>
        {remoteMasterError.value && <FormRow label={<span role="alert" class="text-danger">{remoteMasterError.value}</span>} />}
        {master && local && <SharingRows />}
        {master && local && host?.enabled && <KeepAwakeRows />}
        {master && local && host?.transport && <TransportStatusRow status={host.transport} enabled={host.enabled} />}
      </FormGroup>

      {master && (
        <>
          <Connections onConnect={setDialog} onShare={local ? () => void share() : undefined} />
          {local && <AuditLog />}
        </>
      )}
      <ConnectEnvironmentDialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        initialLink={dialog?.link}
        initialAddress={dialog?.address}
        initialName={dialog?.name}
        envId={dialog?.envId}
      />
      {local && <AddDeviceDialog open={sharing} onOpenChange={setSharing} />}
    </>
  );
}
