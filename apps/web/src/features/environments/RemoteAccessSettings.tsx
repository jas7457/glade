/**
 * Settings → Remote access (client side, per device; I-123 §5.3): "Connect to other Glade
 * environments" (off by default). Off: only this machine's environment; remote projects, chats
 * and choices are hidden and their connections closed (nothing deleted). On: the environments
 * in this device's list connect again and reappear.
 *
 * The "Connect to environment…" dialog is TEMPORARY (dev, loopback addresses only) until
 * pairing (I-126) replaces it.
 */
import { useState } from "preact/hooks";
import { Plus, Trash2 } from "lucide-preact";
import { connectionFor } from "@/state/env-registry";
import {
  connectEnvironmentByUrl,
  remoteAccessEnabled,
  removeSavedEnvironment,
  savedEnvironments,
  setRemoteAccessEnabled,
} from "@/state/environments";
import { Button, Dialog, FormGroup, FormRow, IconButton, Switch, TextField, confirm } from "@/ui";

const STATUS_TEXT = { connecting: "Connecting…", live: "Connected", offline: "Offline", error: "Can't connect" } as const;

export function RemoteAccessSettings() {
  const enabled = remoteAccessEnabled.value;
  const saved = savedEnvironments.value;
  const [adding, setAdding] = useState(false);

  const remove = async (id: string, name: string) => {
    const ok = await confirm({
      title: "Remove environment?",
      subject: name,
      message: "will be removed from this device's list. Nothing on it is deleted; you can connect again later.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (ok) removeSavedEnvironment(id);
  };

  return (
    <>
      <FormGroup footer="Shows projects and chats of other Glade environments next to this machine's. Turning it off hides them (nothing is deleted).">
        <FormRow label="Connect to other Glade environments" htmlFor="remote-access">
          <Switch id="remote-access" checked={enabled} onCheckedChange={setRemoteAccessEnabled} />
        </FormRow>
      </FormGroup>

      <FormGroup
        title="Environments"
        actions={
          <Button size="sm" disabled={!enabled} onClick={() => setAdding(true)}>
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
            const status = conn ? STATUS_TEXT[conn.status.value] : "Not connected";
            return (
              <FormRow key={e.id} label={conn?.name.value ?? e.name} description={`${e.urls[0] ?? ""} · ${status}`}>
                <IconButton size="sm" label={`Remove ${e.name}`} onClick={() => void remove(e.id, e.name)}>
                  <Trash2 />
                </IconButton>
              </FormRow>
            );
          })
        )}
      </FormGroup>
      <ConnectEnvironmentDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

/** TEMPORARY (dev) until pairing (I-126): connect by a loopback address. */
function ConnectEnvironmentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await connectEnvironmentByUrl(url);
      setUrl("");
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setError(null);
        onOpenChange(next);
      }}
      title="Connect to Environment"
      description="Enter the address of another Glade on this machine (for development; pairing comes later)."
    >
      <form onSubmit={(e) => void submit(e)} class="flex flex-col gap-3">
        <TextField
          aria-label="Address"
          placeholder="http://127.0.0.1:5418"
          value={url}
          autoFocus
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
        {error && (
          <p role="alert" class="text-[0.92rem] text-danger">
            {error}
          </p>
        )}
        <div class="flex justify-end gap-2">
          <Button type="button" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !url.trim()}>
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
