/**
 * "Connect to Environment…" (I-126, client side): paste a `glade://pair?…` link (or the whole QR
 * text), or type the host's code and address; name this device; then wait for the host to
 * press Allow. The flow itself is `state/pairing.ts` (portable); this is its desktop dialog.
 *
 * `envId` = "Pair again" for an environment whose token stopped working: the address is filled
 * in and the answering host must be that same environment.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { parsePairInput, parsePairingLink } from "@/lib/pairing-link";
import { remoteAccessEnabled, setRemoteAccessEnabled } from "@/state/environments";
import { defaultDeviceName, runPairing, savedEnvironment, type PairState } from "@/state/pairing";
import { Button, Dialog, Spinner, TextField } from "@/ui";

export interface ConnectEnvironmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled link (a `/pair?link=…` deep link). */
  initialLink?: string;
  /** Pair again with this saved environment. */
  envId?: string;
}

export function ConnectEnvironmentDialog({ open, onOpenChange, initialLink, envId }: ConnectEnvironmentDialogProps) {
  const again = envId ? savedEnvironment(envId) : undefined;
  const [input, setInput] = useState("");
  const [address, setAddress] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [state, setState] = useState<PairState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    setInput(initialLink ?? "");
    setAddress(again?.urls[0] ?? "");
    setDeviceName(defaultDeviceName());
    setState(null);
    setFormError(null);
  }, [open, initialLink, envId]);
  useEffect(() => () => abort.current?.abort(), []);

  const isLink = /glade:|\/pair\b/i.test(input);
  const busy = state?.step === "connecting" || state?.step === "waiting";

  const submit = async (e?: Event) => {
    e?.preventDefault();
    const parsed = parsePairInput(input, address);
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    const target = parsed.target;
    if (again) {
      target.environmentId ??= again.id;
      target.name ??= again.name;
      if (!parsePairingLink(input)) target.urls = [...target.urls, ...again.urls.filter((u) => !target.urls.includes(u))];
    }
    setFormError(null);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const result = await runPairing(target, { deviceName, deviceKind: "mac", signal: controller.signal, onState: setState });
    if (abort.current !== controller) return;
    if (result.step === "paired") {
      if (!remoteAccessEnabled.value) setRemoteAccessEnabled(true);
      onOpenChange(false);
    }
  };

  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    if (busy) setState(null);
    else onOpenChange(false);
  };

  const title = again ? `Pair Again with ${again.name}` : "Connect to Environment";
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          abort.current?.abort();
          abort.current = null;
        }
        onOpenChange(next);
      }}
      title={title}
      description={
        again
          ? `${again.name} no longer accepts this device. On ${again.name}, open Settings → Remote Access → Add Device…, then paste the link or type the code here.`
          : "On the other Mac, open Settings → Remote Access → Add Device…, then paste the link here or type its code and address."
      }
      width={460}
      footer={
        busy ? (
          <Button onClick={cancel}>Cancel</Button>
        ) : (
          <>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!input.trim()} onClick={() => void submit()}>
              {state?.step === "error" ? "Try Again" : "Connect"}
            </Button>
          </>
        )
      }
    >
      {busy ? (
        <div class="flex items-center gap-3 py-2" role="status">
          <Spinner />
          <span class="text-fg">{state.step === "waiting" ? `Waiting for ${state.hostName} to allow this device…` : "Connecting…"}</span>
        </div>
      ) : (
        <form
          onSubmit={(e) => void submit(e)}
          // Return in any field connects, like the Connect button (the button sits outside the form).
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.isComposing || !(e.target instanceof HTMLInputElement) || !input.trim()) return;
            e.preventDefault();
            void submit();
          }}
          class="flex flex-col gap-3"
        >
          <label class="flex flex-col gap-1">
            <span class="text-[0.92rem] text-fg-muted">Pairing link or code</span>
            <TextField
              aria-label="Pairing link or code"
              placeholder="glade://pair?… or ABCD-EFGH"
              mono
              value={input}
              autoFocus
              onInput={(e) => {
                setInput(e.currentTarget.value);
                setFormError(null);
              }}
            />
          </label>
          {!isLink && (
            <label class="flex flex-col gap-1">
              <span class="text-[0.92rem] text-fg-muted">Address</span>
              <TextField aria-label="Address" placeholder="192.168.1.20:4327" mono value={address} onInput={(e) => setAddress(e.currentTarget.value)} />
            </label>
          )}
          <label class="flex flex-col gap-1">
            <span class="text-[0.92rem] text-fg-muted">Name of this device</span>
            <TextField aria-label="Name of this device" value={deviceName} onInput={(e) => setDeviceName(e.currentTarget.value)} />
          </label>
          {(formError || state?.step === "error") && (
            <p role="alert" class="text-[0.92rem] text-danger">
              {formError ?? (state?.step === "error" ? state.message : null)}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}
