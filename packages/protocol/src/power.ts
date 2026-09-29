/**
 * Keeping the Mac awake (I-147) and the desktop shell's menu bar state (I-150).
 *
 * The server decides *why* the Mac should stay awake (`AwakeReason`s: chats working on this
 * server; sharing on with a device connected, subject to `Settings.power` and the power source)
 * and publishes a `PowerStatus`:
 *
 *   GET /api/power                     → PowerStatus (local owner only; also pushed as `power`)
 *   GET /api/desktop/state?after=<rev> → DesktopShellState (long-poll for the Mac app's shell:
 *                                        answers at once when `rev` differs, else on the next
 *                                        change or after ~25 s)
 *
 * Only the Mac app holds a power assertion (IOKit `PreventUserIdleSystemSleep`, the display may
 * still sleep): `held` is true only on its server (`GLADE_SERVER_KIND=desktop`). A web-only
 * `pnpm dev` server reports the reasons but holds nothing.
 */

export type AwakeReason =
  /** Chats (workspaces) with a run in progress on this server (running or retrying). */
  | { kind: "working"; chats: number }
  /** Sharing is on and these devices have a socket open to this server. */
  | { kind: "shared"; devices: string[] };

export type PowerSource = "ac" | "battery";

export interface PowerStatus {
  /** Why the Mac should stay awake now; empty = no reason (sleep as usual). */
  reasons: AwakeReason[];
  /** The reasons in words (`awakeReasonText`), e.g. "2 chats are working"; empty for none. */
  text: string;
  /** The Mac app holds a power assertion for them (false on web-only servers or with no reasons). */
  held: boolean;
  /** This server can hold one at all (the Mac app's server). */
  canHold: boolean;
  /** Where the power comes from; `null` when unknown (desktops, other platforms). */
  powerSource: PowerSource | null;
  /**
   * Sharing is on with a device connected but that doesn't keep the Mac awake because of the
   * settings or the battery (so the UI can say why).
   */
  sharedSkipped: "setting" | "battery" | null;
}

/** "2 chats working", "Jason's iPhone connected", joined with " · ". Empty string for none. */
export function awakeReasonText(reasons: readonly AwakeReason[]): string {
  return reasons
    .map((r) => {
      if (r.kind === "working") return r.chats === 1 ? "a chat is working" : `${r.chats} chats are working`;
      return `${deviceList(r.devices)} ${r.devices.length === 1 ? "is" : "are"} connected`;
    })
    .join(" · ");
}

/** "iPhone", "iPhone and iPad", "iPhone and 2 other devices". */
export function deviceList(devices: readonly string[]): string {
  if (devices.length === 0) return "no device";
  if (devices.length === 1) return devices[0]!;
  if (devices.length === 2) return `${devices[0]} and ${devices[1]}`;
  return `${devices[0]} and ${devices.length - 1} other devices`;
}

/** The desktop shell's view of this server: menu bar icon + menu, and the power assertion. */
export interface DesktopShellState {
  /** Changes whenever anything below changes (long-poll cursor). */
  rev: number;
  chats: {
    /** Top-level chats working anywhere on the data folder. */
    working: number;
    /** Chats that need the user (waiting for input or unread), like the Dock badge. */
    needsYou: number;
  };
  sharing: {
    /** This Mac is shared (host switch and master switch on). */
    on: boolean;
    /** Names of the devices connected right now. */
    devices: string[];
  };
  power: PowerStatus;
}

/** Inputs of {@link computeAwakeReasons}. */
export interface AwakeInputs {
  /** Chats with a run in progress on this server. */
  workingChats: number;
  sharingOn: boolean;
  connectedDevices: string[];
  powerSource: PowerSource | null;
  settings: { whileWorking: boolean; whileShared: boolean; whileSharedOnBattery: boolean };
}

/**
 * The awake rules (pure):
 * 1. chats working on this server, unless "Keep this Mac awake while a chat is working" is off;
 * 2. sharing on + ≥ 1 connected device, when "Keep this device awake while it's shared" is on and
 *    the Mac is on AC power (or the power source is unknown, e.g. a desktop Mac), or on battery
 *    when "Also on battery" is on too.
 */
export function computeAwakeReasons(input: AwakeInputs): Pick<PowerStatus, "reasons" | "sharedSkipped"> {
  const reasons: AwakeReason[] = [];
  if (input.settings.whileWorking && input.workingChats > 0) reasons.push({ kind: "working", chats: input.workingChats });
  let sharedSkipped: PowerStatus["sharedSkipped"] = null;
  if (input.sharingOn && input.connectedDevices.length > 0) {
    if (!input.settings.whileShared) sharedSkipped = "setting";
    else if (input.powerSource === "battery" && !input.settings.whileSharedOnBattery) sharedSkipped = "battery";
    else reasons.push({ kind: "shared", devices: [...input.connectedDevices] });
  }
  return { reasons, sharedSkipped };
}
