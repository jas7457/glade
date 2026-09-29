/**
 * First run (and Settings → Add Device): "Connect to a Device" (I-164, doc §5.1). Glade on the
 * iPhone uses your Macs: scan the QR code from a Mac's Share This Device…, paste its link, or
 * type its code + address. The pairing itself runs in `state/connect.ts`. The Name field (I-171) is
 * what the Mac calls this iPhone (iOS doesn't tell apps the phone's own name); saved on the phone.
 */
import { useSignal } from "@preact/signals";
import { ClipboardPaste, KeyRound, QrCode, Smartphone } from "lucide-preact";
import { useNavigate } from "react-router";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { paths } from "~/app/routes";
import { IPHONE_DEVICE_NAME, MAX_PHONE_NAME, phoneName, setPhoneName } from "~/state/connect";
import { NavBar, PhoneButton, PhoneInput, Screen, ScreenBody } from "~/ui/phone";
import { PairSheet, type PairMode } from "./PairSheet";

export function ConnectScreen() {
  const navigate = useNavigate();
  const mode = useSignal<PairMode | null>(null);
  const name = useSignal(phoneName.value);
  // Saved when it loses focus and before pairing starts (the pairing request carries it).
  const saveName = () => (name.value = setPhoneName(name.value));
  const open = (m: PairMode) => {
    saveName();
    mode.value = m;
  };
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
        <label class="mb-5 block">
          <span class="block px-4 pb-1.5 text-[13px] text-fg-muted uppercase">This iPhone's name</span>
          <PhoneInput
            class="bg-fg/6"
            aria-label="This iPhone's name"
            placeholder={IPHONE_DEVICE_NAME}
            maxLength={MAX_PHONE_NAME}
            value={name.value}
            onInput={(e) => (name.value = (e.currentTarget as HTMLInputElement).value)}
            onBlur={saveName}
            autoCorrect="off"
            enterKeyHint="done"
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
            }}
          />
          <span class="block px-4 pt-1.5 text-[13px] text-fg-muted">Your Mac shows this name when you pair.</span>
        </label>
        <div class="flex flex-col gap-3 pb-2">
          <PhoneButton onClick={() => open("scan")}>
            <QrCode size={20} /> Scan QR Code
          </PhoneButton>
          <PhoneButton kind="tinted" onClick={() => open("link")}>
            <ClipboardPaste size={20} /> Paste Link
          </PhoneButton>
          <PhoneButton kind="tinted" onClick={() => open("code")}>
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
