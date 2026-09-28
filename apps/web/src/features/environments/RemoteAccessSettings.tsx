/**
 * Settings → Remote Access, in two parts (I-123, I-125/I-126):
 *
 * - **This Mac** (host, local environment only): "Allow other devices to connect", Add Device…,
 *   the paired devices and recent activity (`HostRemoteAccess`).
 * - **Other Environments** (client, per device): "Connect to other Glade environments" (off by
 *   default; off hides remote projects and chats and closes their connections, nothing is
 *   deleted), the environments this device paired with, and "Connect to Environment…" (pairing
 *   by link or code, `ConnectEnvironmentDialog`). An environment whose token stopped working
 *   shows "Pair Again…".
 */
import { useEffect, useState } from "preact/hooks";
import { Plus, Trash2 } from "lucide-preact";
import { connectionFor, hasLocalEnvironment, type EnvStatus } from "@/state/env-registry";
import { remoteAccessEnabled, removeSavedEnvironment, savedEnvironments, setRemoteAccessEnabled } from "@/state/environments";
import { pairDialogRequest } from "@/state/pairing";
import { Button, FormGroup, FormRow, IconButton, Switch, confirm } from "@/ui";
import { ConnectEnvironmentDialog } from "./ConnectEnvironmentDialog";
import { HostRemoteAccess } from "./HostRemoteAccess";

const STATUS_TEXT: Record<EnvStatus, string> = {
  connecting: "Connecting…",
  live: "Connected",
  offline: "Offline",
  error: "Can't connect",
  "needs-pairing": "Needs pairing",
  "remote-disabled": "Remote access is off there",
};

function PartHeading({ children }: { children: string }) {
  return <h2 class="mt-2 mb-3 text-[1.1rem] font-semibold text-fg-strong">{children}</h2>;
}

export function RemoteAccessSettings() {
  const enabled = remoteAccessEnabled.value;
  const saved = savedEnvironments.value;
  const [dialog, setDialog] = useState<{ link?: string; envId?: string } | null>(null);

  // A `/pair?link=…` deep link or "Pair Again…" elsewhere asked for the dialog.
  const request = pairDialogRequest.value;
  useEffect(() => {
    if (!request) return;
    setDialog(request);
    pairDialogRequest.value = null;
  }, [request]);

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
    <>
      {hasLocalEnvironment.value && (
        <>
          <PartHeading>This Mac</PartHeading>
          <HostRemoteAccess />
        </>
      )}

      <PartHeading>Other Environments</PartHeading>
      <FormGroup footer="Shows projects and chats of other Glade environments next to this Mac's. Turning it off hides them (nothing is deleted).">
        <FormRow label="Connect to other Glade environments" htmlFor="remote-access">
          <Switch id="remote-access" checked={enabled} onCheckedChange={setRemoteAccessEnabled} />
        </FormRow>
      </FormGroup>

      <FormGroup
        title="Environments"
        actions={
          <Button size="sm" onClick={() => setDialog({})}>
            <Plus size={12} />
            Connect to Environment…
          </Button>
        }
      >
        {saved.length === 0 ? (
          <FormRow label={<span class="text-fg-muted">No other environments yet.</span>} />
        ) : (
          saved.map((e) => {
            const conn = enabled ? connectionFor(e.id) : undefined;
            const status = conn?.status.value;
            const needsPairing = !e.token || status === "needs-pairing";
            const text = !e.token ? "Needs pairing" : status ? STATUS_TEXT[status] : "Not connected";
            return (
              <FormRow key={e.id} label={conn?.name.value ?? e.name} description={`${e.urls[0] ?? ""} · ${text}`}>
                {needsPairing && (
                  <Button size="sm" onClick={() => setDialog({ envId: e.id })}>
                    Pair Again…
                  </Button>
                )}
                <IconButton size="sm" label={`Remove ${e.name}`} onClick={() => void remove(e.id, e.name)}>
                  <Trash2 />
                </IconButton>
              </FormRow>
            );
          })
        )}
      </FormGroup>
      <ConnectEnvironmentDialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)} initialLink={dialog?.link} envId={dialog?.envId} />
    </>
  );
}
