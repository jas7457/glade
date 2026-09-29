/**
 * What an unreachable Mac means on the iPhone (I-170). The phone has no Tailscale peer list (no
 * local server), so it can never tell "offline" from "can't reach": instead of the desktop's bare
 * "Can't reach Studio" it says what to check, with a Retry. The states themselves are the shared
 * `state/remote-status.ts`; only the phone's words live here (desktop wording is unchanged).
 */
import { connectionFor } from "@glade/app-core/state/env-registry";
import { remoteStateText, type RemoteState } from "@glade/app-core/state/remote-status";

/** One line: "Can't reach Studio", "Connecting to Studio…". */
export function macStatusTitle(state: RemoteState, name: string): string {
  if (state === "connecting") return `Connecting to ${name}…`;
  // Without peers "offline" never comes up on the phone; if it did, "can't reach" still holds.
  if (state === "host-offline") return `Can't reach ${name}`;
  return remoteStateText(state, name);
}

/** What to do about it (null: nothing to do). */
export function macStatusHint(state: RemoteState, name: string): string | null {
  switch (state) {
    case "unreachable":
    case "host-offline":
      return "Make sure it's awake with Glade open, and Tailscale is on on both.";
    case "remote-disabled":
      return `Turn Remote Access back on in Glade → Settings on ${name}.`;
    case "needs-pairing":
      return `${name} no longer accepts this iPhone. Share it again from the Mac and pair again.`;
    default:
      return null;
  }
}

/** Short, for pickers and subtitles ("Can't reach"). */
export function macStatusShort(state: RemoteState): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "remote-disabled":
      return "Remote access off";
    case "host-offline":
    case "unreachable":
      return "Can't reach";
    case "needs-pairing":
      return "Needs pairing";
  }
}

/** Retry makes sense (the Mac may come back any moment): reconnect now instead of waiting. */
export function canRetryMac(state: RemoteState): boolean {
  return state === "unreachable" || state === "host-offline" || state === "remote-disabled";
}

/** Reconnect to that Mac now (skips the backoff). */
export function retryMac(envId: string): void {
  connectionFor(envId)?.retry?.();
}
