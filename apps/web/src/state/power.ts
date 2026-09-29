/**
 * Keeping this device awake (I-147): the local server's `PowerStatus` (`GET /api/power`, pushed as
 * `power` on the local socket). Shown as "Keeping this device awake: …" in Settings → General and
 * Remote Access. The settings themselves are `Settings.power` (server settings).
 */
import { signal } from "@preact/signals";
import type { PowerStatus, ServerMessage } from "@glade/protocol";
import { request } from "@/lib/api";
import { socket as localSocket, type Socket } from "@/lib/socket";

/** `null` until loaded, or on servers without it. */
export const powerStatus = signal<PowerStatus | null>(null);

export async function loadPower(): Promise<void> {
  try {
    const status = await request<PowerStatus>("GET", "/power");
    if (status && Array.isArray(status.reasons)) powerStatus.value = status;
  } catch {
    /* older server, or not the owner */
  }
}

export function receivePowerMessage(message: ServerMessage): void {
  if (message.type === "batch") {
    for (const m of message.messages) receivePowerMessage(m);
    return;
  }
  if (message.type === "power") powerStatus.value = message.power;
}

/** Load and follow pushes while mounted (catches up on every reconnect). Returns a stop function. */
export function watchPower(socket: Socket = localSocket): () => void {
  const offs = [socket.onMessage(receivePowerMessage), socket.onOpen(() => void loadPower())];
  void loadPower();
  return () => offs.forEach((off) => off());
}

/**
 * The status line, or null when there's nothing to say. `canHold` false (a browser on `pnpm dev`)
 * says the Mac app would do it.
 */
export function powerStatusText(status: PowerStatus | null): string | null {
  if (!status) return null;
  if (!status.reasons.length) {
    if (status.sharedSkipped === "battery") return "Not keeping this device awake for connected devices while it's on battery power.";
    return null;
  }
  const reason = status.text.charAt(0).toUpperCase() + status.text.slice(1);
  if (!status.canHold) return `${reason}. Only the Glade app keeps this device awake, not a browser on a development server.`;
  return `Keeping this device awake: ${status.text}.`;
}

/** A closed lid still sleeps: nothing an app can change. */
export const LID_HINT = "A closed laptop lid still puts the Mac to sleep unless it's on power with an external display. The display may turn off either way.";

/** Tests. */
export function resetPower(): void {
  powerStatus.value = null;
}
