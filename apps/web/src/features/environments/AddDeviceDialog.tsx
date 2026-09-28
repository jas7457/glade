/**
 * "Add Device…" (I-126, host side): creates a one-time invite (5 minutes, one at a time) and
 * shows it three ways: a QR code of the link, the link to copy (another Mac pastes it into
 * "Connect to Environment…"), and the short code with this Mac's address for typing. A live
 * countdown; "Create New Code" once it expired. Cancel withdraws the invite.
 *
 * An invite is used up by the first pair request (server rule). When that request arrives, the
 * app-wide confirm (PendingPairingHost) appears on top and this dialog shows "Waiting for your
 * answer…"; then "Paired ✓ <device>" with Done, or, after Deny (or another window's / expired
 * answer without a new device), "This code was used" with "Create New Code".
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Check } from "lucide-preact";
import type { PairingInvite, PendingPairing } from "@glade/protocol";
import { hostAuth } from "@/lib/api-auth";
import { hostRemote, loadDevices, pairedDevices, pairingAnswers, pendingPairings } from "@/state/remote-host";
import { Button, Dialog, QrCode, Spinner, TextField } from "@/ui";

/** `4:05` */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** What happened to the current invite. */
type InviteUse =
  | { step: "open" }
  | { step: "waiting"; pending: PendingPairing }
  | { step: "paired"; deviceName: string }
  | { step: "used"; deviceName: string; denied: boolean };

export function AddDeviceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [invite, setInvite] = useState<PairingInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [use, setUse] = useState<InviteUse>({ step: "open" });
  /** Pairings already waiting when the invite was made (not ours) and when it was made. */
  const before = useRef<{ ids: Set<string>; at: number }>({ ids: new Set(), at: 0 });
  const now = useNow(open && !!invite && use.step === "open");

  const create = async () => {
    setInvite(null);
    setError(null);
    setCopied(false);
    setUse({ step: "open" });
    before.current = { ids: new Set(pendingPairings.value.map((p) => p.id)), at: Date.now() };
    try {
      setInvite(await hostAuth.createInvite());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    if (!open) return;
    void create();
  }, [open]);

  // A pair request arrived: it used this invite. Then follow its answer.
  const pending = pendingPairings.value;
  const answers = pairingAnswers.value;
  useEffect(() => {
    if (!open || !invite) return;
    if (use.step === "open") {
      const ours = pending.find((p) => !before.current.ids.has(p.id));
      if (ours) setUse({ step: "waiting", pending: ours });
      return;
    }
    if (use.step !== "waiting" || pending.some((p) => p.id === use.pending.id)) return;
    const name = use.pending.deviceName;
    const answer = answers.get(use.pending.id);
    if (answer !== undefined) {
      setUse(answer ? { step: "paired", deviceName: name } : { step: "used", deviceName: name, denied: true });
      return;
    }
    // Answered elsewhere (another window) or timed out: a new device means it was allowed.
    void loadDevices().then(() => {
      const added = (pairedDevices.value ?? []).some((d) => d.createdAt >= before.current.at - 5_000 && d.name === name);
      setUse(added ? { step: "paired", deviceName: name } : { step: "used", deviceName: name, denied: false });
    });
  }, [open, invite, pending, answers, use]);

  const close = (withdraw: boolean) => {
    if (withdraw && invite && use.step === "open" && invite.expiresAt > Date.now()) void hostAuth.cancelInvite().catch(() => {});
    setInvite(null);
    onOpenChange(false);
  };

  const remaining = invite ? invite.expiresAt - now : 0;
  const expired = !!invite && use.step === "open" && remaining <= 0;
  const spent = use.step === "used";
  const dimmed = expired || use.step !== "open";
  const address = hostRemote.value?.addresses[0] ?? null;

  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close(true))}
      title="Add Device"
      description="On the other device, open Glade → Settings → Remote Access → Connect to Environment…, then paste the link or type the code. You'll be asked to allow it here."
      width={460}
      footer={
        use.step === "paired" ? (
          <Button variant="primary" onClick={() => close(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={() => close(true)}>Cancel</Button>
            {(expired || spent) && (
              <Button variant="primary" onClick={() => void create()}>
                Create New Code
              </Button>
            )}
          </>
        )
      }
    >
      {error ? (
        <p role="alert" class="text-danger">
          Couldn't create an invite: {error}
        </p>
      ) : use.step === "paired" ? (
        <div role="status" class="flex items-center gap-2 py-2 text-fg">
          <Check size={16} class="shrink-0 text-success" aria-hidden="true" />
          <span>
            Paired with <span class="font-medium text-fg-strong">{use.deviceName}</span>. It can use this Mac now.
          </span>
        </div>
      ) : !invite ? (
        <div class="flex h-[184px] items-center justify-center">
          <Spinner />
        </div>
      ) : (
        <div class="flex flex-col gap-4">
          <div class="flex items-start gap-4">
            <div class={dimmed ? "opacity-25" : undefined}>
              <QrCode value={invite.link} size={168} label="QR code of the pairing link" />
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <div class="text-[0.92rem] text-fg-muted">Code</div>
              <div data-testid="pair-code" class={`selectable font-mono text-[1.9rem] leading-tight font-semibold tracking-[0.06em] text-fg-strong ${dimmed ? "line-through opacity-40" : ""}`}>
                {invite.code}
              </div>
              {address && (
                <>
                  <div class="mt-2 text-[0.92rem] text-fg-muted">Address</div>
                  <div class="selectable font-mono text-[0.92rem] break-all text-fg">{address}</div>
                </>
              )}
              <div role="timer" aria-live="off" class={`mt-2 text-[0.92rem] ${expired || spent ? "text-danger" : "text-fg-muted"}`}>
                {use.step === "waiting"
                  ? `“${use.pending.deviceName}” used this code. Waiting for your answer…`
                  : spent
                    ? `This code was used${use.denied ? ` (you denied “${use.deviceName}”)` : ` by “${use.deviceName}”`}. Create a new one to pair.`
                    : expired
                      ? "This code expired."
                      : `Expires in ${formatCountdown(remaining)}`}
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2">
            <TextField aria-label="Pairing link" readOnly mono size="md" value={invite.link} disabled={dimmed} onFocus={(e) => e.currentTarget.select()} />
            <Button disabled={dimmed} onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
