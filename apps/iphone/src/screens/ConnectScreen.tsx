/**
 * First run (and Settings → Add Device): "Connect to a Device" (I-164, doc §5.1). Glade on the
 * iPhone uses your Macs: scan the QR code from a Mac's Share This Device…, paste its link, or
 * type its code + address. The pairing itself runs in `state/connect.ts`.
 */
import { useSignal } from "@preact/signals";
import { ClipboardPaste, KeyRound, QrCode, Smartphone } from "lucide-preact";
import { useNavigate } from "react-router";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { paths } from "~/app/routes";
import { NavBar, PhoneButton, Screen, ScreenBody } from "~/ui/phone";
import { PairSheet, type PairMode } from "./PairSheet";

export function ConnectScreen() {
  const navigate = useNavigate();
  const mode = useSignal<PairMode | null>(null);
  const hasDevices = savedEnvironments.value.length > 0;
  return (
    <Screen>
      <NavBar
        left={
          hasDevices ? (
            <PhoneButton kind="plain" onClick={() => navigate(-1)}>
              Cancel
            </PhoneButton>
          ) : undefined
        }
      />
      <ScreenBody class="flex flex-col px-6">
        <div class="flex flex-1 flex-col items-center justify-center py-8 text-center">
          <div class="mb-5 flex size-20 items-center justify-center rounded-[22px] bg-accent/12 text-accent">
            <Smartphone size={40} strokeWidth={1.6} />
          </div>
          <h1 class="text-[28px] leading-tight font-bold text-fg-strong">Connect to a Device</h1>
          <p class="mt-3 text-fg-muted">
            Glade on your iPhone uses your Macs. On a Mac, open Glade → Settings → Remote Access → <b class="font-semibold">Share This Device…</b>, then scan
            its code here.
          </p>
        </div>
        <div class="flex flex-col gap-3 pb-2">
          <PhoneButton onClick={() => (mode.value = "scan")}>
            <QrCode size={20} /> Scan QR Code
          </PhoneButton>
          <PhoneButton kind="tinted" onClick={() => (mode.value = "link")}>
            <ClipboardPaste size={20} /> Paste Link
          </PhoneButton>
          <PhoneButton kind="tinted" onClick={() => (mode.value = "code")}>
            <KeyRound size={20} /> Enter Code
          </PhoneButton>
          <p class="pt-2 text-center text-[13px] text-fg-muted">The Tailscale app must be installed on this iPhone and signed in to the same tailnet as your Macs.</p>
        </div>
      </ScreenBody>
      <PairSheet
        mode={mode.value}
        onClose={() => (mode.value = null)}
        onPaired={() => {
          mode.value = null;
          navigate(paths.home(), { replace: true });
        }}
      />
    </Screen>
  );
}
