/**
 * Settings → Remote Access, sharing this device (I-125/I-126; I-136 layout): the "Let other
 * devices use this device" switch (off by default, `PATCH /api/auth/remote`; can't turn on while
 * the transport isn't usable, I-127) with this device's address under it while it's on, and the
 * audit log behind "Recent activity". Paired devices are listed in Connections
 * (`Connections.tsx`). Local environment only; `RemoteAccessSettings` loads `hostRemote`.
 */
import { useEffect, useState } from "preact/hooks";
import type { AuditAction, AuditEntry } from "@glade/protocol";
import { hostAuth } from "@glade/app-core/lib/api-auth";
import { hostRemote, hostRemoteError, hostRemoteSwitchError, setHostRemote } from "@glade/app-core/state/remote-host";
import { Disclosure, FormRow, Switch } from "@glade/app-core/ui";
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

/** The address other devices use: the tailnet one while serving (else the listening one, without a transport). */
export function shareAddress(): string | null {
  const state = hostRemote.value;
  const transport = state?.transport;
  if (transport) return transport.serving && transport.dnsName ? `https://${transport.dnsName}` : null;
  return state?.addresses[0] ?? null;
}

/** Rows for the Remote access group: the sharing switch and, while it's on, the address. */
export function SharingRows() {
  const state = hostRemote.value;
  const enabled = state?.enabled ?? false;
  const transport = state?.transport;
  // Turning on needs a usable transport; turning off always works.
  const blocked = !enabled && !!transport && !transport.available;
  const address = shareAddress();
  return (
    <>
      <FormRow
        label="Let other devices use this device"
        description={
          hostRemoteError.value && !state ? (
            <span class="text-danger">Couldn't load remote access: {hostRemoteError.value}</span>
          ) : (
            "Each new device needs your OK here."
          )
        }
        htmlFor="host-remote"
      >
        <Switch id="host-remote" checked={enabled} disabled={!state || blocked} onCheckedChange={(on) => void setHostRemote(on)} />
      </FormRow>
      {enabled && (
        <FormRow
          label="Address"
          description={address ? <span class="selectable font-mono">{address}</span> : "Not reachable yet: waiting for Tailscale."}
        />
      )}
      {hostRemoteSwitchError.value && <FormRow label={<span role="alert" class="text-danger">{hostRemoteSwitchError.value}</span>} />}
    </>
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

export function AuditLog() {
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
