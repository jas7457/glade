/**
 * Settings → Remote Access: the transport (I-127). One row under the "Remote access" master
 * switch (I-132: it carries both directions; I-136: below the sharing switch, which shows the
 * `https://<machine>.<tailnet>.ts.net` address) with the transport's state: Tailscale ✓, or
 * what's wrong with fix-it text and a link (HTTPS off → the admin console's DNS page, not
 * installed → the download page). HTTPS is required: there's no plain-HTTP fallback.
 */
import type { ComponentChildren } from "preact";
import { AlertTriangle, CheckCircle2 } from "lucide-preact";
import type { TransportProblem, TransportStatus } from "@glade/protocol";
import { FormRow } from "@glade/app-core/ui";

export const TAILSCALE_ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";
export const TAILSCALE_DOWNLOAD_URL = "https://tailscale.com/download";

function Link({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" class="text-accent hover:underline">
      {children}
    </a>
  );
}

/** Fix-it text for each problem (`reason` is the server's short sentence). */
function fixIt(problem: TransportProblem | undefined, reason: string | undefined): ComponentChildren {
  switch (problem) {
    case "not_installed":
      return (
        <>
          Tailscale isn't installed. Install it on this computer and on each device that should connect, and sign in with the same account.{" "}
          <Link href={TAILSCALE_DOWNLOAD_URL}>Download Tailscale</Link>
        </>
      );
    case "cli_not_found":
      return <>{reason ?? "Glade can't find the Tailscale command-line tool."} In Tailscale's settings, turn on CLI integration (it installs /usr/local/bin/tailscale).</>;
    case "not_running":
      return <>{reason ?? "Tailscale isn't running."} Open the Tailscale app.</>;
    case "stopped":
      return <>Tailscale is turned off. Connect it from the Tailscale menu.</>;
    case "signed_out":
      return <>Tailscale is signed out. Sign in from the Tailscale menu.</>;
    case "https_off":
      return (
        <>
          HTTPS is off in your tailnet, and Glade only shares over HTTPS. In the Tailscale admin console, open DNS, make sure MagicDNS is on, then click Enable
          HTTPS under HTTPS Certificates. <Link href={TAILSCALE_ADMIN_DNS_URL}>Open the admin console</Link>
        </>
      );
    case "funnel_on":
      return <>{reason} Glade won't share this device while Funnel is on for that port; turn Funnel off first.</>;
    case "port_in_use":
      return <>{reason} Remove that Serve entry to let Glade use the port.</>;
    default:
      return reason ?? "Tailscale isn't usable right now.";
  }
}

export interface TransportStatusRowProps {
  status: TransportStatus;
  /** The host switch ("Let other devices use this device") is on. */
  enabled: boolean;
}

export function TransportStatusRow({ status, enabled }: TransportStatusRowProps) {
  const ok = status.available && status.problem === undefined;
  let text: ComponentChildren;
  if (!ok) text = fixIt(status.problem, status.reason);
  // The address itself is shown under the sharing switch (I-136).
  else if (enabled && status.serving) text = "Reachable on your private tailnet.";
  else if (enabled)
    text = status.managed
      ? "Starting Tailscale Serve…"
      : "The Glade app runs Tailscale Serve for this data folder; this device becomes reachable while it's open.";
  else
    text = (
      <>
        Ready{status.dnsName ? <> as <span class="selectable font-mono">{status.dnsName}</span></> : null}. Glade only uses your private tailnet, never Funnel.
      </>
    );
  return (
    <FormRow
      label={
        <span class="flex items-center gap-1.5">
          {ok ? (
            <CheckCircle2 size={14} class="shrink-0 text-success" aria-label="Available" />
          ) : (
            <AlertTriangle size={14} class="shrink-0 text-warning" aria-label="Unavailable" />
          )}
          Tailscale
        </span>
      }
      description={
        <>
          <span data-testid="transport-status">{text}</span>
          {status.error && <span class="mt-0.5 block text-danger">{status.error}</span>}
        </>
      }
    />
  );
}
