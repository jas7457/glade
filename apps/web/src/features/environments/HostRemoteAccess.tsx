/**
 * Settings → Remote Access, part 1: "This Mac" as a host (I-125/I-126). The "Allow other devices
 * to connect" switch (off by default, `PATCH /api/auth/remote`) with the transport's status
 * (I-127: Tailscale; the switch can't turn on while it isn't usable) and this Mac's addresses,
 * "Add Device…" (invite dialog), the paired devices (rename inline, last seen, Revoke / Revoke
 * All) and the audit log behind "Recent activity". Local environment only.
 */
import { useEffect, useState } from "preact/hooks";
import { Plus } from "lucide-preact";
import type { AuditAction, AuditEntry, PairedDevice } from "@glade/protocol";
import { hostAuth } from "@/lib/api-auth";
import {
  hostRemote,
  hostRemoteError,
  hostRemoteSwitchError,
  loadDevices,
  loadHostRemote,
  pairedDevices,
  renameDevice,
  revokeAllDevices,
  revokeDevice,
  setHostRemote,
} from "@/state/remote-host";
import { Button, Disclosure, FormGroup, FormRow, Switch, TextField, confirm } from "@/ui";
import { AddDeviceDialog } from "./AddDeviceDialog";
import { DeviceKindIcon } from "./device-kind";
import { TransportStatusRow } from "./TransportStatus";

/** "now", "5 min ago", "3 h ago", then a date. */
export function formatLastSeen(at: number | null, now = Date.now()): string {
  if (at === null) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const DEVICES_POLL_MS = 10_000;

export function HostRemoteAccess() {
  const state = hostRemote.value;
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    void loadHostRemote();
    void loadDevices();
    // Last seen, "connected" and the transport's state change without pushes: refresh while this is on screen.
    const timer = setInterval(() => {
      void loadDevices();
      void loadHostRemote();
    }, DEVICES_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const enabled = state?.enabled ?? false;
  const addresses = state?.addresses ?? [];
  const devices = pairedDevices.value ?? [];
  const transport = state?.transport;
  // Turning on needs a usable transport; turning off always works.
  const blocked = !enabled && !!transport && !transport.available;

  const revokeAll = async () => {
    const ok = await confirm({
      title: "Revoke all devices?",
      message: `All ${devices.length} paired devices lose access to this Mac at once. They can pair again with a new code.`,
      confirmLabel: "Revoke All",
      destructive: true,
    });
    if (ok) await revokeAllDevices();
  };

  return (
    <>
      <FormGroup
        footer={
          hostRemoteError.value && !state ? (
            <span class="text-danger">Couldn't load remote access: {hostRemoteError.value}</span>
          ) : (
            <>
              Lets devices you pair (another Mac, later your phone) use this Mac's projects and chats. Each device needs your OK here; nothing is
              reachable while this is off.
              {enabled && addresses.length > 0 && !transport && (
                <span class="mt-1 block">
                  Reachable at <span class="selectable font-mono">{addresses.join(", ")}</span>
                </span>
              )}
            </>
          )
        }
      >
        <FormRow label="Allow other devices to connect" htmlFor="host-remote">
          <Switch id="host-remote" checked={enabled} disabled={!state || blocked} onCheckedChange={(on) => void setHostRemote(on)} />
        </FormRow>
        {transport && <TransportStatusRow status={transport} enabled={enabled} />}
        {hostRemoteSwitchError.value && (
          <FormRow label={<span role="alert" class="text-danger">{hostRemoteSwitchError.value}</span>} />
        )}
      </FormGroup>

      <FormGroup
        title="Devices"
        actions={
          <>
            {devices.length > 1 && (
              <Button size="sm" onClick={() => void revokeAll()}>
                Revoke All…
              </Button>
            )}
            <Button size="sm" disabled={!enabled} onClick={() => setAdding(true)}>
              <Plus size={12} />
              Add Device…
            </Button>
          </>
        }
      >
        {devices.length === 0 ? (
          <FormRow label={<span class="text-fg-muted">No paired devices.</span>} />
        ) : (
          devices.map((d) => <DeviceRow key={d.id} device={d} />)
        )}
      </FormGroup>

      <AuditLog />
      <AddDeviceDialog open={adding} onOpenChange={setAdding} />
    </>
  );
}

function DeviceRow({ device }: { device: PairedDevice }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(device.name);
  const [error, setError] = useState<string | null>(null);

  const commit = async () => {
    setEditing(false);
    const next = name.trim();
    if (!next || next === device.name) {
      setName(device.name);
      return;
    }
    try {
      await renameDevice(device.id, next);
      setError(null);
    } catch (err) {
      setName(device.name);
      setError((err as Error).message);
    }
  };

  const revoke = async () => {
    const ok = await confirm({
      title: "Revoke device?",
      subject: device.name,
      message: "loses access to this Mac at once (open connections are closed). It can pair again with a new code.",
      confirmLabel: "Revoke",
      destructive: true,
    });
    if (ok) await revokeDevice(device.id).catch((err: Error) => setError(err.message));
  };

  const seen = device.connected ? "now" : formatLastSeen(device.lastSeenAt);
  const details = [`Last seen ${seen}`, device.lastAddress, device.tailscaleLogin].filter(Boolean).join(" · ");

  return (
    <FormRow
      label={
        <span class="flex min-w-0 items-center gap-2">
          <DeviceKindIcon kind={device.kind} />
          {editing ? (
            <TextField
              size="sm"
              aria-label="Device name"
              value={name}
              autoFocus
              onInput={(e) => setName(e.currentTarget.value)}
              onBlur={() => void commit()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commit();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setName(device.name);
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span
              class="min-w-0 truncate"
              title="Double-click to rename"
              onDblClick={() => {
                setName(device.name);
                setEditing(true);
              }}
            >
              {device.name}
            </span>
          )}
          {device.connected && <span aria-label="Connected" class="size-1.5 shrink-0 rounded-full bg-success" />}
        </span>
      }
      description={error ? <span class="text-danger">{error}</span> : details}
    >
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
        Rename
      </Button>
      <Button size="sm" onClick={() => void revoke()}>
        Revoke…
      </Button>
    </FormRow>
  );
}

const AUDIT_TEXT: Record<AuditAction, string> = {
  invite_created: "Invite created",
  invite_cancelled: "Invite cancelled",
  pair_requested: "Pairing requested",
  pair_allowed: "Pairing allowed",
  pair_denied: "Pairing denied",
  pair_failed: "Pairing failed",
  device_revoked: "Device revoked",
  device_renamed: "Device renamed",
  auth_failed: "Rejected request",
  remote_enabled: "Remote access turned on",
  remote_disabled: "Remote access turned off",
};

function AuditLog() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    hostAuth.listAudit(50).then(
      (list) => {
        setEntries(list);
        setError(null);
      },
      (err: Error) => setError(err.message),
    );
  }, [open]);
  return (
    <Disclosure label="Recent activity" open={open} onOpenChange={setOpen} class="mb-6">
      <div class="mt-1 rounded-[9px] shadow-[0_0_0_0.5px_var(--pi-separator)]">
        {error ? (
          <p class="px-3 py-2 text-[0.92rem] text-danger">{error}</p>
        ) : !entries ? (
          <p class="px-3 py-2 text-[0.92rem] text-fg-muted">Loading…</p>
        ) : entries.length === 0 ? (
          <p class="px-3 py-2 text-[0.92rem] text-fg-muted">No activity yet.</p>
        ) : (
          <ul class="selectable divide-y divide-separator text-[0.92rem]">
            {entries.map((e, i) => (
              <li key={`${e.at}-${i}`} class="flex gap-3 px-3 py-1.5">
                <time class="shrink-0 text-fg-muted tabular-nums">{new Date(e.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
                <span class="min-w-0 flex-1 text-fg">
                  {AUDIT_TEXT[e.action] ?? e.action}
                  {e.deviceName && <> · {e.deviceName}</>}
                  {e.detail && <span class="text-fg-muted"> · {e.detail}</span>}
                </span>
                {e.remoteAddress && <span class="shrink-0 font-mono text-fg-muted">{e.remoteAddress}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Disclosure>
  );
}
