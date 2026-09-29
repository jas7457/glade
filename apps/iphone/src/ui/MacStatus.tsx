/**
 * A Mac that isn't connected, the phone's way (I-170): "Can't reach Studio", what to check
 * ("Make sure it's awake with Glade open, and Tailscale is on on both.") and Retry, which
 * reconnects now. Words in `lib/mac-status.ts`.
 *
 * - `MacStatusNotice`: a card (New Chat's empty state, a chat whose Mac dropped).
 * - `MacStatusRow`: a list row (the chat list's device rows); tapping the row opens the device,
 *   Retry retries.
 * Both render nothing while the Mac is connected.
 */
import { Monitor } from "lucide-preact";
import { cn } from "@glade/app-core/lib/cn";
import { connectionFor } from "@glade/app-core/state/env-registry";
import { remoteStateOf } from "@glade/app-core/state/remote-status";
import { savedEnvironments } from "@glade/app-core/state/saved-environments";
import { Spinner } from "@glade/app-core/ui";
import { canRetryMac, macStatusHint, macStatusTitle, retryMac } from "~/lib/mac-status";
import { PhoneButton } from "./phone";

function macName(envId: string): string {
  const saved = savedEnvironments.value.find((e) => e.id === envId);
  return connectionFor(envId)?.name.value ?? saved?.alias ?? saved?.name ?? "This Mac";
}

export function MacStatusNotice({ envId, class: className }: { envId: string; class?: string }) {
  const state = remoteStateOf(envId);
  if (state === "connected") return null;
  const name = macName(envId);
  const hint = macStatusHint(state, name);
  return (
    <div role="status" data-mac-status={state} class={cn("flex flex-col items-center gap-1 rounded-2xl bg-cell px-4 py-3.5 text-center", className)}>
      <div class="flex items-center gap-2 text-[17px] font-semibold text-fg-strong">
        {state === "connecting" && <Spinner size={14} />}
        {macStatusTitle(state, name)}
      </div>
      {hint && <p class="text-[15px] text-fg-muted">{hint}</p>}
      {canRetryMac(state) && (
        <PhoneButton kind="tinted" block={false} class="mt-2 min-h-9 px-5 text-[15px]" onClick={() => retryMac(envId)}>
          Retry
        </PhoneButton>
      )}
    </div>
  );
}

export function MacStatusRow({ envId, onOpen }: { envId: string; onOpen?: (envId: string) => void }) {
  const state = remoteStateOf(envId);
  if (state === "connected") return null;
  const name = macName(envId);
  const hint = macStatusHint(state, name);
  return (
    <div data-down-environment={envId} class="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-fg-muted">
      <button type="button" onClick={() => onOpen?.(envId)} class="flex min-w-0 flex-1 items-center gap-3 text-left select-none active:opacity-60">
        <Monitor size={20} class="shrink-0" aria-hidden />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-fg">{macStatusTitle(state, name)}</span>
          {hint && <span class="block text-[13px] leading-snug">{hint}</span>}
        </span>
      </button>
      {state === "connecting" ? (
        <Spinner size={14} />
      ) : canRetryMac(state) ? (
        <PhoneButton kind="plain" block={false} class="min-h-9 shrink-0 px-2 text-[15px] font-normal" onClick={() => retryMac(envId)}>
          Retry
        </PhoneButton>
      ) : (
        <span class="shrink-0 text-fg-subtle" aria-hidden>
          ›
        </span>
      )}
    </div>
  );
}
