/**
 * App-wide confirm for pairing requests (I-126, host side): when another device asks to pair
 * (`pairing_pending` on the local socket), "Allow “Jason's MacBook Air” to use this device?" shows
 * wherever the user is, with where the request came from. Allow / Deny answer it; the next
 * waiting request (if any) follows. A code-free request from your own tailnet (I-143) reads
 * "“MacBook Air” wants to use this device" and shows the 4-digit number the device shows too:
 * Allow only if they match. Mounted once by the app shell; only for a local environment.
 */
import { useEffect } from "preact/hooks";
import { Laptop } from "lucide-preact";
import { hasLocalEnvironment } from "@/state/env-registry";
import { answerPairing, pendingPairings, watchHostPairing } from "@/state/remote-host";
import { Button, Dialog } from "@/ui";
import { DeviceKindIcon, deviceKindLabel } from "./device-kind";

export function PendingPairingHost() {
  const local = hasLocalEnvironment.value;
  useEffect(() => (local ? watchHostPairing() : undefined), [local]);
  const pending = pendingPairings.value[0];
  if (!pending) return null;
  const answer = (allow: boolean) => void answerPairing(pending.id, allow).catch(() => {});
  return (
    <Dialog
      key={pending.id}
      open
      // A choice is required: Escape and clicks outside don't dismiss it.
      onOpenChange={() => {}}
      icon={<Laptop />}
      title={pending.number ? `“${pending.deviceName}” wants to use this device` : `Allow “${pending.deviceName}” to use this device?`}
      description={
        pending.number
          ? `Allow only if ${pending.deviceName} shows the same number. It will see and use all projects and chats on this device, and run agents here, until you revoke it in Settings → Remote Access.`
          : "It will see and use all projects and chats on this device, and run agents here, until you revoke it in Settings → Remote Access."
      }
      width={400}
      onOpenAutoFocus={(e) => {
        // Deny is the safe default (Return denies).
        e.preventDefault();
        (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[data-deny]")?.focus();
      }}
      footer={
        <>
          <Button data-deny onClick={() => answer(false)}>
            Deny
          </Button>
          <Button variant="primary" onClick={() => answer(true)}>
            Allow
          </Button>
        </>
      }
    >
      {pending.number && (
        <p
          class="selectable mb-3 text-center font-mono text-[2rem] leading-tight font-semibold tracking-[0.25em] text-fg"
          data-testid="pair-number"
          aria-label={`Number ${pending.number.split("").join(" ")}`}
        >
          {pending.number}
        </p>
      )}
      <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.92rem]">
        <dt class="text-fg-muted">Device</dt>
        <dd class="flex min-w-0 items-center gap-1.5 text-fg">
          <DeviceKindIcon kind={pending.deviceKind} size={13} />
          {deviceKindLabel(pending.deviceKind)}
        </dd>
        <dt class="text-fg-muted">From</dt>
        <dd class="selectable min-w-0 font-mono break-all text-fg">{pending.remoteAddress ?? "Unknown address"}</dd>
        {pending.tailscaleLogin && (
          <>
            <dt class="text-fg-muted">Tailscale</dt>
            <dd class="selectable min-w-0 break-all text-fg">{pending.tailscaleLogin}</dd>
          </>
        )}
      </dl>
      {pendingPairings.value.length > 1 && <p class="mt-3 text-[0.92rem] text-fg-muted">{pendingPairings.value.length - 1} more waiting.</p>}
    </Dialog>
  );
}
