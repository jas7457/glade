/**
 * "Connect to a Device…" (I-126; I-136 name, client side): paste a `glade://pair?…` link (or the
 * whole QR text), or type the host's code; then wait for the host to press Allow. The flow itself
 * is `state/pairing.ts` (portable); this is its desktop dialog.
 *
 * I-138: when the target is known (a device found on the tailnet, a pasted or `/pair?link=`
 * link, Pair Again) the dialog shows a read-only "Connecting to <name> · <host>" line and no
 * address field. A typed code needs the address: then the address field shows, with the devices
 * found on the tailnet (I-127/I-137, `use-discovery.ts`) as quick picks. The code is always
 * required: finding a host establishes no trust. There's no name field: the host is told this
 * device's own environment name, and names it as it likes afterwards.
 *
 * I-143: when that known target is a device found on the tailnet (or Pair Again with a Tailscale address),
 * opening the dialog pairs without a code: this device asks, both show the same 4-digit number
 * ("Check that Studio shows 4729") and the host presses Allow. If the host can't take a code-free
 * request (another Tailscale account, no Tailscale identity, sharing off, busy…), the dialog shows
 * the code field with a one-line reason. Cancel also falls back to the code field; with the field
 * empty, Connect (or Try Again) asks without a code again.
 *
 * `envId` = "Pair again" for an environment whose token stopped working: the answering host must
 * be that same environment.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { Check, Monitor, RefreshCw } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";
import { parsePairInput, parsePairingLink } from "@glade/app-core/lib/pairing-link";
import { connectionName } from "@glade/app-core/state/connections";
import { connectionFor, localEnvironmentId } from "@glade/app-core/state/env-registry";
import { remoteMaster, setRemoteMaster } from "@glade/app-core/state/remote-master";
import { adoptDeviceName } from "@glade/app-core/state/remote-host";
import { defaultDeviceName, isTailnetAddress, runPairing, runTailnetPairing, savedEnvironment, type PairState } from "@glade/app-core/state/pairing";
import { Button, Dialog, Spinner, TextField } from "@glade/app-core/ui";
import { useDiscovery } from "./use-discovery";

export interface ConnectEnvironmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefilled link (a `/pair?link=…` deep link). */
  initialLink?: string;
  /** Prefilled address (a computer found on the tailnet, I-132). */
  initialAddress?: string;
  /** Its name, shown in the read-only target line (I-138). */
  initialName?: string;
  /** Pair again with this saved environment. */
  envId?: string;
}

export function ConnectEnvironmentDialog({ open, onOpenChange, initialLink, initialAddress, initialName, envId }: ConnectEnvironmentDialogProps) {
  const again = envId ? savedEnvironment(envId) : undefined;
  const againName = again ? (connectionFor(again.id)?.name.value ?? connectionName({ alias: again.alias, fallback: again.name })) : undefined;
  const [input, setInput] = useState("");
  const [address, setAddress] = useState("");
  const [state, setState] = useState<PairState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** Why code-free pairing isn't possible with this host (I-143): the code field is required. */
  const [codeReason, setCodeReason] = useState<string | null>(null);
  /** The running (or last) attempt is code-free. */
  const [viaTailnet, setViaTailnet] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const codeField = useRef<HTMLInputElement>(null);
  // Only this device's own server can look around its tailnet; elsewhere (no local server) it's empty.
  const discovery = useDiscovery(open);
  const own = localEnvironmentId.value;
  const found = discovery.found.filter((d) => d.environmentId !== own);

  // I-143: a known Tailscale target (no link) pairs without a code.
  const tailnetUrl = !initialLink ? (again ? again.urls.find(isTailnetAddress) : initialAddress || undefined) : undefined;
  useEffect(() => {
    if (!open) return;
    setInput(initialLink ?? "");
    setAddress(again?.urls[0] ?? initialAddress ?? "");
    setState(null);
    setFormError(null);
    setCodeReason(null);
    if (tailnetUrl) void connectWithoutCode();
  }, [open, initialLink, initialAddress, envId]);
  useEffect(() => () => abort.current?.abort(), []);

  const isLink = /glade:|\/pair\b/i.test(input);
  const link = isLink ? parsePairingLink(input) : null;
  /** The known target (read-only line, no address field), or null: a typed code needs an address. */
  const target: { name: string; address: string } | null = link
    ? { name: link.name || hostOf(link.urls[0] ?? ""), address: link.urls[0] ?? "" }
    : again
      ? { name: againName!, address: again.urls[0] ?? "" }
      : initialAddress
        ? { name: initialName || hostOf(initialAddress), address: initialAddress }
        : null;
  const needsAddress = !target && !isLink && input.trim() !== "";
  const busy = state?.step === "connecting" || state?.step === "waiting" || state?.step === "confirm";
  /** Connect with an empty code field asks without a code (I-143). */
  const codeFree = !!tailnetUrl && !codeReason && !input.trim();

  const paired = (result: PairState) => {
    if (result.step !== "paired") return;
    adoptDeviceName(result.environment.id);
    // Pairing means using remote access (I-132: the master switch).
    if (!remoteMaster.value) void setRemoteMaster(true);
    onOpenChange(false);
  };

  async function connectWithoutCode() {
    if (!tailnetUrl) return;
    setFormError(null);
    setViaTailnet(true);
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const result = await runTailnetPairing(
      { url: tailnetUrl, name: again ? againName : initialName || undefined, environmentId: again?.id },
      { deviceName: defaultDeviceName(), deviceKind: "mac", signal: controller.signal, onState: setState },
    );
    if (abort.current !== controller) return;
    if (result.step === "error" && result.kind === "needs-code") {
      setCodeReason(result.message);
      setState(null);
      queueMicrotask(() => codeField.current?.focus());
    }
    paired(result);
  }

  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (codeFree) return void connectWithoutCode();
    setViaTailnet(false);
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
    const result = await runPairing(target, { deviceName: defaultDeviceName(), deviceKind: "mac", signal: controller.signal, onState: setState });
    if (abort.current !== controller) return;
    paired(result);
  };

  const cancel = () => {
    abort.current?.abort();
    abort.current = null;
    if (busy) setState(null);
    else onOpenChange(false);
  };

  const title = again ? `Pair Again with ${againName}` : "Connect to a Device";
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
        busy && viaTailnet
          ? `No code needed: ${target?.name ?? "the other device"} checks that it's your Tailscale account and asks there.`
          : again
          ? `${againName} no longer accepts this device. On ${againName}, open Settings → Remote Access → Share This Device…, then paste the link or type the code here.`
          : target
            ? `On ${target.name}, open Settings → Remote Access → Share This Device…, then paste the link or type the code here.`
            : "On the other computer, open Settings → Remote Access → Share This Device…, then paste the link here or type its code."
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
            <Button variant="primary" disabled={!input.trim() && !codeFree} onClick={() => void submit()}>
              {state?.step === "error" ? "Try Again" : "Connect"}
            </Button>
          </>
        )
      }
    >
      {state?.step === "confirm" ? (
        <div class="flex flex-col items-center gap-1.5 py-2 text-center" role="status">
          <span class="text-fg">Check that {state.hostName} shows</span>
          <span class="selectable font-mono text-[2rem] leading-tight font-semibold tracking-[0.25em] text-fg" data-testid="pair-number" aria-label={`Number ${state.number.split("").join(" ")}`}>
            {state.number}
          </span>
          <span class="flex items-center gap-2 text-[0.92rem] text-fg-muted">
            <Spinner size={12} />
            Then press Allow there. If the numbers differ, press Deny.
          </span>
        </div>
      ) : busy ? (
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
          {target && (
            <p class="flex min-w-0 items-center gap-2 text-fg" data-testid="connect-target">
              <Monitor size={14} class="shrink-0 text-fg-muted" />
              <span class="min-w-0 truncate">
                Connecting to <span class="font-medium">{target.name}</span>
                {target.address && <span class="text-fg-muted"> · {hostOf(target.address)}</span>}
              </span>
            </p>
          )}
          {codeReason && (
            <p class="text-[0.92rem] text-fg-muted" data-testid="code-reason">
              {codeReason}
            </p>
          )}
          <label class="flex flex-col gap-1">
            <span class="text-[0.92rem] text-fg-muted">Pairing link or code</span>
            <TextField
              ref={codeField}
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
          {needsAddress && (
            <>
              <label class="flex flex-col gap-1">
                <span class="text-[0.92rem] text-fg-muted">Address</span>
                <TextField aria-label="Address" placeholder="https://mac-studio.tail1234.ts.net" mono value={address} onInput={(e) => setAddress(e.currentTarget.value)} />
                <span class="text-[0.85rem] text-fg-muted">The address shown on the other device under Share This Device.</span>
              </label>
              {found.length > 0 && (
                <div class="flex flex-col gap-1">
                  <span class="flex items-center justify-between gap-2">
                    <span class="text-[0.92rem] text-fg-muted">Found on your tailnet</span>
                    <Button size="sm" variant="ghost" aria-label="Refresh" disabled={discovery.refreshing} onClick={discovery.refresh}>
                      {discovery.refreshing ? <Spinner size={12} /> : <RefreshCw size={12} />}
                      Refresh
                    </Button>
                  </span>
                  <ul aria-label="Found on your tailnet" class="divide-y divide-separator overflow-hidden rounded-[7px] shadow-[0_0_0_0.5px_var(--pi-separator)]">
                    {found.map((d) => {
                      const selected = address === d.address;
                      return (
                        <li key={d.address}>
                          <button
                            type="button"
                            aria-pressed={selected}
                            class={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left", selected ? "bg-selected" : "hover:bg-hover")}
                            onClick={() => {
                              setAddress(d.address);
                              setFormError(null);
                            }}
                          >
                            <Monitor size={14} class="shrink-0 text-fg-muted" />
                            <span class="min-w-0 flex-1 truncate text-fg">{d.name}</span>
                            <span class="min-w-0 truncate font-mono text-[0.85rem] text-fg-muted">{hostOf(d.address)}</span>
                            {d.environmentId && savedEnvironment(d.environmentId) && <span class="shrink-0 text-[0.85rem] text-fg-muted">Paired</span>}
                            <Check size={13} class={cn("shrink-0 text-accent", !selected && "invisible")} />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </>
          )}
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

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
