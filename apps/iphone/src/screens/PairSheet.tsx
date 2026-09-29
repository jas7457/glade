/**
 * The pairing sheet (I-164): paste a link, or type a code + address, then follow the pairing
 * (connecting → "press Allow on <Mac>" → paired / error). Scanning (mode "scan") opens the
 * camera first (`lib/scan.ts`) and continues here with the scanned link.
 */
import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { CircleAlert, CircleCheck } from "lucide-preact";
import { Spinner } from "@/ui";
import { cancelPairing, pairState, startPairing } from "~/state/connect";
import { cancelScan, scanPairingLink } from "~/lib/scan";
import { PhoneButton, PhoneInput, PhoneTextArea, Sheet } from "~/ui/phone";

export type PairMode = "scan" | "link" | "code";

const TITLE: Record<PairMode, string> = { scan: "Scan QR Code", link: "Paste Link", code: "Enter Code" };

export function PairSheet({ mode, onClose, onPaired }: { mode: PairMode | null; onClose: () => void; onPaired: () => void }) {
  const link = useSignal("");
  const code = useSignal("");
  const address = useSignal("");
  const scanError = useSignal<string | null>(null);
  const state = pairState.value;

  useEffect(() => {
    link.value = "";
    code.value = "";
    address.value = "";
    scanError.value = null;
    pairState.value = null;
    if (mode !== "scan") return;
    let live = true;
    void scanPairingLink().then(
      (text) => {
        if (!live) return;
        if (text) void startPairing(text);
        else onClose();
      },
      (err: Error) => {
        if (live) scanError.value = err.message;
      },
    );
    return () => {
      live = false;
    };
  }, [mode]);

  useEffect(() => {
    if (state?.step !== "paired") return;
    const t = setTimeout(onPaired, 900);
    return () => clearTimeout(t);
  }, [state?.step]);

  const close = () => {
    if (mode === "scan") cancelScan();
    cancelPairing();
    onClose();
  };

  const busy = state?.step === "connecting" || state?.step === "waiting" || state?.step === "confirm";
  const submit = () => void (mode === "code" ? startPairing(code.value, address.value) : startPairing(link.value));

  let body;
  if (state && state.step !== "error" && state.step !== "cancelled") {
    body = <Progress state={state} />;
  } else if (mode === "scan") {
    body = (
      <div class="px-6 py-8 text-center text-fg-muted">
        {scanError.value ? <Problem message={scanError.value} /> : state?.step === "error" ? <Problem message={state.message} /> : <Spinner />}
      </div>
    );
  } else {
    body = (
      <form
        class="flex flex-col gap-3 px-4 pt-2 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {mode === "link" ? (
          <>
            <PhoneTextArea
              rows={4}
              placeholder="glade://pair?…"
              value={link.value}
              onInput={(e) => (link.value = e.currentTarget.value)}
              autoCapitalize="off"
              autoCorrect="off"
              spellcheck={false}
              aria-label="Pairing link"
            />
            <p class="px-1 text-[13px] text-fg-muted">On the Mac, Share This Device… → Copy Link, then paste it here.</p>
          </>
        ) : (
          <>
            <PhoneInput
              placeholder="Code (ABCD-EFGH)"
              value={code.value}
              onInput={(e) => (code.value = e.currentTarget.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellcheck={false}
              aria-label="Pairing code"
            />
            <PhoneInput
              placeholder="Address (https://mac.tailnet.ts.net)"
              value={address.value}
              onInput={(e) => (address.value = e.currentTarget.value)}
              type="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellcheck={false}
              aria-label="Address"
            />
            <p class="px-1 text-[13px] text-fg-muted">Both are shown on the Mac under the QR code.</p>
          </>
        )}
        {state?.step === "error" && <Problem message={state.message} />}
        <PhoneButton type="submit" disabled={busy || (mode === "link" ? !link.value.trim() : !code.value.trim())}>
          Connect
        </PhoneButton>
      </form>
    );
  }

  return (
    <Sheet open={mode !== null} onClose={close} title={mode ? TITLE[mode] : undefined}>
      {body}
    </Sheet>
  );
}

function Problem({ message }: { message: string }) {
  return (
    <p role="alert" class="flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2.5 text-left text-[15px] text-danger">
      <CircleAlert size={18} class="mt-0.5 shrink-0" /> <span>{message}</span>
    </p>
  );
}

function Progress({ state }: { state: NonNullable<typeof pairState.value> }) {
  let icon = <Spinner />;
  let title = "Connecting…";
  let text: string | null = null;
  if (state.step === "waiting") {
    title = `Waiting for ${state.hostName}`;
    text = `Press Allow on ${state.hostName} to let this iPhone in.`;
  } else if (state.step === "confirm") {
    title = `Waiting for ${state.hostName}`;
    text = `Check that ${state.hostName} shows ${state.number}, then press Allow there.`;
  } else if (state.step === "paired") {
    icon = <CircleCheck size={36} class="text-success" />;
    title = `Connected to ${state.environment.alias ?? state.environment.name}`;
  }
  return (
    <div class="flex flex-col items-center gap-3 px-6 py-10 text-center" aria-live="polite">
      {icon}
      <div class="text-[20px] font-semibold text-fg-strong">{title}</div>
      {text && <p class="text-fg-muted">{text}</p>}
    </div>
  );
}
